/// <reference types="node" />
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Colourway, Design, Hero, Layer, Manifest, Op, Slots, TemplateId, TextLayer } from '../../types';
import { applyOps, autoFix, brandScore, buildDesign, checkDesign, measureText, summarizeDesign } from '../index';
import { SAFE } from '../../brand';
import { wrap } from '../text';
import { BLOOM_GRID } from '../shapes';

const SIZES = [
  { width: 1080, height: 1350 },
  { width: 1080, height: 1080 },
  { width: 1080, height: 1920 },
];
const TEMPLATES: TemplateId[] = ['card', 'bold', 'checklist', 'split', 'offer'];
const COLOURWAYS: Colourway[] = ['light', 'dark', 'blue'];
const HEROES: Hero[] = [
  { type: 'photo', photoTag: 'florist', photoUrl: null },
  { type: 'photo', photoTag: 'cafe', photoUrl: '/static/gen/bank/cafe_1.png' },
  { type: 'device', deviceId: 'device_phone_hand_payments' },
  { type: 'device', deviceId: 'device_laptop_welcome' },
  { type: 'device', deviceId: 'device_tablet_kitchen' },
  { type: 'illustration', illustrationId: 'illus_loop_coins_sky' },
  { type: 'none' },
];

function slots(template: TemplateId, colourway: Colourway, hero: Hero, extra: Partial<Slots> = {}): Slots {
  return {
    template,
    colourway,
    headline: 'Cash flow without the suspense.',
    headline2: 'Xero holds your hand.',
    sub: 'See what is coming in. Plan what is going out.',
    cta: 'See how with Xero',
    items: ['Payroll', 'Super', 'Me time'],
    tags: true,
    stat: { label: 'Cash flow', value: 'R12,500', variant: 'sparkline' },
    hero,
    bloom: 'harmony',
    charms: [
      { charm: 'sparkle', colour: 'yellow' },
      { charm: 'heart', colour: 'pink' },
    ],
    ...extra,
  };
}

function textExtentOk(d: Design, l: TextLayer) {
  const st = { font: l.font, weight: l.fontWeight, size: l.fontSize, letterSpacing: l.letterSpacing ?? 0 };
  const lines = wrap(l.text, st, l.width);
  const widest = Math.max(...lines.map((t) => measureText(t, l.font, l.fontWeight, l.fontSize, l.letterSpacing ?? 0)));
  const h = lines.length * l.fontSize * l.lineHeight;
  return (
    l.x >= -0.5 &&
    l.y >= -0.5 &&
    l.x + l.width <= d.width + 0.5 &&
    l.y + Math.max(h, l.height) <= d.height + 0.5 &&
    widest <= l.width + 1 &&
    h <= l.height + 1
  );
}

function assertGood(d: Design, label: string, manifest: Manifest | null = null) {
  const errors = checkDesign(d, manifest).filter((i) => i.severity === 'error');
  expect(errors.map((e) => `${e.rule} ${e.layerId ?? ''} ${e.message}`), label).toEqual([]);
  expect(d.layers.filter((l) => l.kind === 'logo').length, label).toBe(1);
  expect(d.layers.filter((l) => l.kind === 'button').length, label).toBe(1);
  for (const l of d.layers) {
    if (l.kind === 'text') expect(textExtentOk(d, l), `${label} ${l.id} on canvas`).toBe(true);
    expect(Number.isFinite(l.x) && Number.isFinite(l.y) && l.width > 0 && l.height > 0, `${label} ${l.id} finite`).toBe(true);
  }
  const ids = d.layers.map((l) => l.id);
  expect(new Set(ids).size, `${label} unique ids`).toBe(ids.length);
  for (const l of d.layers) expect(l.id, label).toMatch(/^[a-z0-9-]+-\d+$/);
  for (const l of d.layers) if (l.role) expect(l.id.startsWith(`${l.role}-`), `${label} ${l.id} role prefix`).toBe(true);
}

/** Pairs of text-bearing layers (text ink extents, CTA, logo, tags, stat) that overlap by more than 2px. */
function textOverlaps(d: Design, label: string): string[] {
  const texty = (l: Layer) => ['text', 'button', 'logo', 'tags', 'stat'].includes(l.kind);
  const box = (l: Layer) => {
    if (l.kind !== 'text') return { x0: l.x, y0: l.y, x1: l.x + l.width, y1: l.y + l.height };
    const st = { font: l.font, weight: l.fontWeight, size: l.fontSize, letterSpacing: l.letterSpacing ?? 0 };
    const lines = wrap(l.text, st, l.width);
    const w = Math.max(...lines.map((t) => measureText(t, l.font, l.fontWeight, l.fontSize, l.letterSpacing ?? 0)));
    const x0 = l.align === 'center' ? l.x + (l.width - w) / 2 : l.align === 'right' ? l.x + l.width - w : l.x;
    return { x0, y0: l.y, x1: x0 + w, y1: l.y + lines.length * l.fontSize * l.lineHeight };
  };
  const out: string[] = [];
  const ls = d.layers.filter(texty);
  for (let i = 0; i < ls.length; i++)
    for (let j = i + 1; j < ls.length; j++) {
      const a = box(ls[i]);
      const b = box(ls[j]);
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 2 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 2)
        out.push(`${label} ${ls[i].id} x ${ls[j].id}`);
    }
  return out;
}

describe('buildDesign', () => {
  for (const t of TEMPLATES)
    for (const c of COLOURWAYS)
      for (const size of SIZES)
        it(`${t} ${c} ${size.width}x${size.height}`, () => {
          for (const hero of HEROES) {
            const d = buildDesign(slots(t, c, hero), size, null);
            assertGood(d, `${t}/${c}/${size.height}/${hero.type}:${hero.deviceId ?? hero.illustrationId ?? hero.photoUrl ?? ''}`);
            expect(d.width).toBe(size.width);
            expect(d.height).toBe(size.height);
          }
        });

  it('never overlaps text, CTA, logo, tags or stat with each other', () => {
    const bad: string[] = [];
    for (const t of TEMPLATES)
      for (const c of COLOURWAYS)
        for (const size of SIZES)
          for (const hero of HEROES)
            bad.push(...textOverlaps(buildDesign(slots(t, c, hero), size, null), `${t}/${c}/${size.height}/${hero.type}:${hero.deviceId ?? ''}`));
    expect(bad).toEqual([]);
  });

  it('is deterministic', () => {
    const s = slots('card', 'light', HEROES[0]);
    expect(buildDesign(s, SIZES[0], null)).toEqual(buildDesign(s, SIZES[0], null));
  });

  it('keeps text, logo and CTA inside the 9:16 safe zone', () => {
    for (const t of TEMPLATES) {
      const d = buildDesign(slots(t, 'dark', HEROES[0]), SIZES[2], null);
      for (const l of d.layers) {
        if (!['text', 'button', 'logo'].includes(l.kind)) continue;
        expect(l.y, `${t} ${l.id} top`).toBeGreaterThanOrEqual(d.height * SAFE.story.top - 1);
        expect(l.y + l.height, `${t} ${l.id} bottom`).toBeLessThanOrEqual(d.height * (1 - SAFE.story.bottom) + 1);
        if (l.x + l.width > d.width * (1 - SAFE.story.bottomRightW))
          expect(l.y + l.height, `${t} ${l.id} bottom-right`).toBeLessThanOrEqual(d.height * (1 - SAFE.story.bottomRightH) + 1);
      }
    }
  });

  it('auto-shrinks long headlines and wraps by sentence', () => {
    const short = buildDesign(slots('bold', 'dark', HEROES[0], { headline: 'Data in. Doubt out.' }), SIZES[0], null);
    const h = short.layers.find((l) => l.role === 'headline') as TextLayer;
    expect(h.text).toBe('Data in.\nDoubt out.');
    const long = buildDesign(
      slots('bold', 'dark', HEROES[0], { headline: 'Clear setup so you can finally clear your whole schedule and relax today.' }),
      SIZES[0],
      null,
    );
    const hl = long.layers.find((l) => l.role === 'headline') as TextLayer;
    expect(hl.fontSize).toBeLessThan(h.fontSize);
    expect(hl.fontSize).toBeGreaterThanOrEqual(h.fontSize * 0.69);
  });

  it('uses the photo slot and marks missing photos as loading', () => {
    const a = buildDesign(slots('card', 'light', HEROES[0]), SIZES[0], null);
    const p = a.layers.find((l) => l.kind === 'photo');
    expect(p && p.kind === 'photo' && p.src === null && p.status === 'loading').toBe(true);
    const b = buildDesign(slots('bold', 'dark', HEROES[1]), SIZES[0], null);
    const q = b.layers.find((l) => l.kind === 'photo');
    expect(q && q.kind === 'photo' && q.src === '/static/gen/bank/cafe_1.png' && q.mask === 'harmony').toBe(true);
  });

  it('adds a disclaimer for offer copy', () => {
    const d = buildDesign(slots('offer', 'light', HEROES[0], { headline: 'Get 90% off for 6 months.', disclaimer: null }), SIZES[0], null);
    expect(d.layers.some((l) => l.role === 'disclaimer')).toBe(true);
  });

  it('survives junk slots', () => {
    const d = buildDesign({ template: 'nope', colourway: 'x', headline: '', cta: '', hero: null } as unknown as Slots, SIZES[0], null);
    expect(d.layers.filter((l) => l.kind === 'logo').length).toBe(1);
  });
});

const refsPath = fileURLToPath(new URL('../../../../backend/data/references.json', import.meta.url));
describe.runIf(existsSync(refsPath))('reference library', () => {
  const refs = existsSync(refsPath) ? (JSON.parse(readFileSync(refsPath, 'utf8')) as { id: string; slots: Slots }[]) : [];
  const manifestPath = fileURLToPath(new URL('../../../../backend/static/brand/manifest.json', import.meta.url));
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest) : null;
  for (const r of refs)
    it(`ref ${r.id}`, () => {
      for (const size of SIZES) {
        assertGood(buildDesign(r.slots, size, null), `ref ${r.id} ${size.height}`);
        const withManifest = buildDesign(r.slots, size, manifest);
        assertGood(withManifest, `ref ${r.id} ${size.height} (manifest)`, manifest);
        expect(textOverlaps(withManifest, `ref ${r.id} ${size.height}`)).toEqual([]);
      }
    });
});

describe('checker + autoFix', () => {
  const base = () => buildDesign(slots('card', 'light', HEROES[1]), SIZES[0], null);
  const seeded = (d: Design, ops: Op[]) => applyOps(d, ops, null).design;
  const rules = (d: Design) => new Set(checkDesign(d, null).map((i) => i.rule));

  it('starts clean', () => {
    expect(checkDesign(base(), null).filter((i) => i.severity === 'error')).toEqual([]);
    expect(brandScore(checkDesign(base(), null))).toBeGreaterThanOrEqual(85);
  });

  it('catches and fixes seeded violations', () => {
    const d0 = base();
    const logo = d0.layers.find((l) => l.kind === 'logo')!;
    const cta = d0.layers.find((l) => l.kind === 'button')!;
    const head = d0.layers.find((l) => l.role === 'headline')!;
    const sub = d0.layers.find((l) => l.role === 'sub')!;
    const photo = d0.layers.find((l) => l.kind === 'photo')!;
    const charm = d0.layers.find((l) => l.kind === 'charm')!;
    const blooms = d0.layers.filter((l) => l.kind === 'bloom');
    const d = seeded(d0, [
      { op: 'update', id: logo.id, props: { colour: 'white', height: logo.height * 1.6 } },
      { op: 'add', layer: { ...cta, id: 'cta-9', y: cta.y + 300 } as Layer },
      { op: 'update', id: head.id, props: { text: 'Get 50% off today', fill: 'pink' } },
      { op: 'update', id: sub.id, props: { fontSize: 14, x: -40 } },
      { op: 'update', id: photo.id, props: { x: 200, y: 700, width: 600, height: 500 } },
      { op: 'update', id: charm.id, props: { width: charm.width * 2 } },
      { op: 'update', id: blooms[0].id, props: { colour: 'mint' } },
      { op: 'update', id: blooms[1].id, props: { colour: 'yellow' } },
      { op: 'add', layer: { id: 'bloom-x', kind: 'bloom', shape: 'x', colour: 'lilac', x: 0, y: 0, width: 100, height: 94 } },
      { op: 'add', layer: { id: 'bloom-y', kind: 'bloom', shape: 'x', colour: 'pink', x: 900, y: 0, width: 100, height: 94 } },
    ]);
    const found = rules(d);
    for (const r of ['logo-colour', 'logo-aspect', 'cta-count', 'text-colour', 'headline-punctuation', 'min-font-size', 'off-canvas', 'disclaimer', 'photo-treatment', 'aspect', 'bloom-colours'])
      expect(found.has(r as never), r).toBe(true);
    const fixed = autoFix(d, null);
    expect(fixed.fixed.length).toBeGreaterThan(5);
    const left = checkDesign(fixed.design, null).filter((i) => i.severity === 'error');
    expect(left.map((i) => `${i.rule}: ${i.message}`)).toEqual([]);
    // An extra CTA is a soft default: flagged as a warning, never auto-deleted (the user may have asked for it).
    expect(fixed.design.layers.filter((l) => l.kind === 'button').length).toBe(2);
  });

  it('flags missing logo and logo on a photo', () => {
    const d0 = base();
    const logo = d0.layers.find((l) => l.kind === 'logo')!;
    const noLogo = seeded(d0, [{ op: 'delete', id: logo.id }]);
    expect(rules(noLogo).has('logo-count')).toBe(true);
    const fixed = autoFix(noLogo, null).design;
    expect(fixed.layers.filter((l) => l.kind === 'logo').length).toBe(1);
    const onPhoto = seeded(d0, [{ op: 'update', id: logo.id, props: { x: 300, y: 1150 } }]);
    const issues = checkDesign(onPhoto, null);
    expect(issues.some((i) => i.rule === 'logo-pill')).toBe(true);
    const f2 = autoFix(onPhoto, null).design.layers.find((l) => l.kind === 'logo')!;
    expect(f2.kind === 'logo' && f2.pill).toBe('white');
  });

  it('enforces the 9:16 safe zone', () => {
    const d0 = buildDesign(slots('bold', 'dark', HEROES[0]), SIZES[2], null);
    const cta = d0.layers.find((l) => l.kind === 'button')!;
    const d = seeded(d0, [{ op: 'update', id: cta.id, props: { y: 1700 } }]);
    expect(rules(d).has('safe-zone-916')).toBe(true);
    expect(rules(autoFix(d, null).design).has('safe-zone-916')).toBe(false);
  });
});

describe('applyOps', () => {
  const d0 = buildDesign(slots('card', 'light', HEROES[1]), SIZES[0], null);
  const head = d0.layers.find((l) => l.role === 'headline') as TextLayer;

  it('update merges props but never id/kind', () => {
    const { design, errors } = applyOps(d0, [{ op: 'update', id: head.id, props: { id: 'zzz', kind: 'rect', fill: 'white' } as never }], null);
    const h = design.layers.find((l) => l.id === head.id)!;
    expect(errors).toEqual([]);
    expect(h.kind).toBe('text');
    expect(h.kind === 'text' && h.fill).toBe('white');
    expect(d0.layers.find((l) => l.id === head.id)!.kind === 'text' && head.fill).toBe('navy'); // input untouched
  });

  it('update reflows text height', () => {
    const { design } = applyOps(d0, [{ op: 'update', id: head.id, props: { text: 'A much much longer headline that needs more lines than before.' } }], null);
    expect(design.layers.find((l) => l.id === head.id)!.height).toBeGreaterThan(head.height);
  });

  it('text edits re-run the layout so nothing below overlaps', () => {
    const long = 'Cash flow without the suspense, the stress or the endless spreadsheets.';
    const { design, errors } = applyOps(d0, [{ op: 'update', id: head.id, props: { text: long, fill: 'navy' } }], null);
    expect(errors).toEqual([]);
    const h = design.layers.find((l) => l.id === head.id) as TextLayer;
    expect(h.text.replace(/\n/g, ' ')).toBe(long);
    const sub = design.layers.find((l) => l.role === 'sub')!;
    const cta = design.layers.find((l) => l.kind === 'button')!;
    expect(sub.y).toBeGreaterThanOrEqual(h.y + h.height - 0.5);
    expect(cta.y).toBeGreaterThanOrEqual(sub.y + sub.height - 0.5);
    expect(design.slots!.headline).toBe(long);
    // CTA copy edits resize the button through the template too
    const r2 = applyOps(design, [{ op: 'update', id: cta.id, props: { text: 'Start your free trial today' } }], null);
    expect(r2.design.layers.find((l) => l.kind === 'button')!.width).toBeGreaterThan(cta.width);
  });

  it('text edits on a hand-moved layout restack instead of rebuilding', () => {
    const logo = d0.layers.find((l) => l.kind === 'logo')!;
    const moved = applyOps(d0, [{ op: 'update', id: logo.id, props: { x: 100, y: 1100 } }], null).design;
    const sub0 = moved.layers.find((l) => l.role === 'sub')!;
    const r = applyOps(moved, [{ op: 'update', id: head.id, props: { text: 'Cash flow without the suspense, the stress or the endless spreadsheets.' } }], null);
    const h = r.design.layers.find((l) => l.id === head.id)!;
    const sub = r.design.layers.find((l) => l.role === 'sub')!;
    expect(r.design.layers.find((l) => l.kind === 'logo')!.y).toBe(1100); // hand edit kept
    expect(sub.y).toBeGreaterThan(sub0.y);
    expect(sub.y).toBeGreaterThanOrEqual(h.y + h.height - 0.5);
  });

  it('add / delete / reorder', () => {
    const layer: Layer = { id: 'charm-x', kind: 'charm', charm: 'heart', colour: 'pink', x: 10, y: 10, width: 100, height: 100 };
    let r = applyOps(d0, [{ op: 'add', layer }], null);
    expect(r.design.layers.at(-1)!.id).toBe('charm-x');
    r = applyOps(r.design, [{ op: 'add', layer: { ...layer, id: 'charm-x' }, index: 0 }], null);
    expect(r.design.layers[0].id).not.toBe('charm-x'); // duplicate id renamed
    expect(r.design.layers[0].kind).toBe('charm');
    r = applyOps(r.design, [{ op: 'reorder', id: 'charm-x', to: 'back' }], null);
    expect(r.design.layers[0].id).toBe('charm-x');
    r = applyOps(r.design, [{ op: 'reorder', id: 'charm-x', to: 'forward' }], null);
    expect(r.design.layers[1].id).toBe('charm-x');
    r = applyOps(r.design, [{ op: 'reorder', id: 'charm-x', to: 'front' }], null);
    expect(r.design.layers.at(-1)!.id).toBe('charm-x');
    r = applyOps(r.design, [{ op: 'delete', id: 'charm-x' }], null);
    expect(r.design.layers.some((l) => l.id === 'charm-x')).toBe(false);
  });

  it('rebuild keeps user edits unless the slot changes', () => {
    const edited = applyOps(d0, [{ op: 'update', id: head.id, props: { text: 'My own words here.' } }], null).design;
    const r = applyOps(edited, [{ op: 'rebuild', slots: { colourway: 'dark' } }], null);
    expect(r.errors).toEqual([]);
    expect(r.design.background).toBe('navy');
    const h = r.design.layers.find((l) => l.role === 'headline') as TextLayer;
    expect(h.text.replace(/\n/g, ' ')).toBe('My own words here.');
    const p = r.design.layers.find((l) => l.kind === 'photo');
    expect(p && p.kind === 'photo' && p.src).toBe('/static/gen/bank/cafe_1.png');
    const r2 = applyOps(edited, [{ op: 'rebuild', slots: { headline: 'New one.' } }], null);
    expect((r2.design.layers.find((l) => l.role === 'headline') as TextLayer).text).toBe('New one.');
    const r3 = applyOps(edited, [{ op: 'rebuild', slots: { template: 'bold' } }], null);
    expect(r3.design.template).toBe('bold');
  });

  it('resize rebuilds with slots, scales without', () => {
    const r = applyOps(d0, [{ op: 'resize', width: 1080, height: 1920 }], null);
    expect(r.design.height).toBe(1920);
    expect(checkDesign(r.design, null).filter((i) => i.severity === 'error')).toEqual([]);
    const bare = { ...d0, slots: undefined };
    const r2 = applyOps(bare, [{ op: 'resize', width: 540, height: 675 }], null);
    expect(r2.design.width).toBe(540);
    const h2 = r2.design.layers.find((l) => l.id === head.id) as TextLayer;
    expect(h2.fontSize).toBeCloseTo(head.fontSize / 2, 0);
  });

  it('reframe puts the face on visible photo, never under the copy card or off-canvas', () => {
    const slots: Slots = {
      template: 'card', colourway: 'light', headline: 'Your craft, not your cash flow.', sub: 'Xero handles the numbers.',
      cta: 'Try Xero for free', hero: { type: 'photo', photoTag: 'florist', photoUrl: '/static/gen/bank/florist_1.png' }, charms: [],
    };
    const d = buildDesign(slots, { width: 1080, height: 1350 }, null);
    const photo = d.layers.find((l) => l.kind === 'photo')!;
    const card = d.layers.find((l) => l.role === 'card')!;
    for (const subject of [[0.5, 0.15], [0.3, 0.3], [0.7, 0.25]] as [number, number][]) {
      const r = applyOps(d, [
        { op: 'update', id: photo.id, props: { subject, srcW: 1536, srcH: 1024 } as Partial<Layer> },
        { op: 'reframe', id: photo.id },
      ], null);
      const p = r.design.layers.find((l) => l.id === photo.id)!;
      if (p.kind !== 'photo') throw new Error('photo missing');
      const k = Math.max(p.width / 1536, p.height / 1024) * p.zoom;
      const fx = p.x + (p.width - 1536 * k) * p.focusX + subject[0] * 1536 * k;
      const fy = p.y + (p.height - 1024 * k) * p.focusY + subject[1] * 1024 * k;
      const underCard = fx > card.x && fx < card.x + card.width && fy > card.y && fy < card.y + card.height;
      expect(underCard, `face at ${fx.toFixed(0)},${fy.toFixed(0)} for subject ${subject}`).toBe(false);
      expect(fx > 0 && fx < 1080 && fy > 0 && fy < 1350).toBe(true);
    }
  });

  it.each([['no manifest', false], ['real manifest', true]])('switching a card to bold keeps a high face inside the visible bloom (%s)', (_n, real) => {
    const mf: Manifest | null = real ? (JSON.parse(readFileSync(fileURLToPath(new URL('../../../../backend/static/brand/manifest.json', import.meta.url)), 'utf8')) as Manifest) : null;
    const slots: Slots = {
      template: 'card', colourway: 'light', headline: 'Less chasing payments. More chasing petals.',
      sub: 'Get paid in a tap, and get back to the blooms.', cta: 'Find out more',
      hero: { type: 'photo', photoTag: 'florist', photoUrl: '/static/gen/bank/florist_2.png' },
      stat: { label: 'Payment received', value: '£250.00', variant: 'check' }, charms: [{ charm: 'heart', colour: 'pink' }],
    };
    const d0 = buildDesign(slots, { width: 1080, height: 1350 }, mf);
    const ph0 = d0.layers.find((l) => l.kind === 'photo')!;
    const subject: [number, number] = [0.5, 0.2];
    const d1 = applyOps(d0, [{ op: 'update', id: ph0.id, props: { subject, srcW: 1536, srcH: 1024 } as Partial<Layer> }], mf).design;
    const d = applyOps(d1, [{ op: 'rebuild', slots: { template: 'bold', colourway: 'dark' } }], mf).design;
    const p = d.layers.find((l) => l.kind === 'photo')!;
    if (p.kind !== 'photo') throw new Error('photo missing');
    const k = Math.max(p.width / 1536, p.height / 1024) * p.zoom;
    const fx = p.x + (p.width - 1536 * k) * p.focusX + subject[0] * 1536 * k;
    const fy = p.y + (p.height - 1024 * k) * p.focusY + subject[1] * 1024 * k;
    const idx = d.layers.indexOf(p);
    const covered = d.layers.slice(idx + 1).some((l) => ['stat', 'button', 'text', 'logo'].includes(l.kind) && fx > l.x && fx < l.x + l.width && fy > l.y && fy < l.y + l.height);
    expect(fx > 0 && fx < 1080 && fy > 0 && fy < 1350, `face ${fx.toFixed(0)},${fy.toFixed(0)}`).toBe(true);
    expect(covered, 'face under copy/stat').toBe(false);
    // Face must land inside the bloom mask's opaque area (not on its transparent corners).
    const u = (fx - p.x) / p.width;
    const v = (fy - p.y) / p.height;
    const rows = p.mask ? BLOOM_GRID[p.mask] : null;
    if (rows) expect(rows[Math.floor(v * rows.length)][Math.floor(u * rows[0].length)], `face u=${u.toFixed(2)} v=${v.toFixed(2)}`).toBe('1');
  });

  it('added blooms and overlapping charms never cover the copy', () => {
    const head = d0.layers.find((l) => l.role === 'headline')!;
    const r = applyOps(d0, [
      { op: 'add', layer: { id: 'b-new', kind: 'bloom', shape: 'peace', colour: 'white', x: head.x, y: head.y, width: 400, height: 300 } },
      { op: 'add', layer: { id: 'c-new', kind: 'charm', charm: 'heart', colour: 'pink', x: head.x + 10, y: head.y + 10, width: 120, height: 120 } },
    ], null);
    const idx = (id: string) => r.design.layers.findIndex((l) => l.id === id);
    expect(idx('b-new')).toBeLessThan(idx(head.id));
    expect(idx('c-new')).toBeLessThan(idx(head.id));
  });

  it('photo / pixel_edit are returned as pending', () => {
    const photo = d0.layers.find((l) => l.kind === 'photo')!;
    const r = applyOps(d0, [{ op: 'photo', id: photo.id, prompt: 'a baker' }, { op: 'pixel_edit', id: photo.id, prompt: 'warmer' }], null);
    expect(r.pending.map((p) => p.op)).toEqual(['photo', 'pixel_edit']);
    const p = r.design.layers.find((l) => l.id === photo.id)!;
    expect(p.kind === 'photo' && p.status).toBe('loading');
  });

  it('invalid ops produce errors, never throw', () => {
    const r = applyOps(
      d0,
      [
        { op: 'update', id: 'nope', props: {} },
        { op: 'delete', id: 'nope' },
        { op: 'teleport' } as unknown as Op,
        null as unknown as Op,
        { op: 'add', layer: { kind: 'unicorn' } } as unknown as Op,
        { op: 'resize', width: -1, height: 5 },
        { op: 'photo', id: head.id, prompt: 'x' },
        { op: 'update', id: head.id, props: { x: 'left' } as never },
      ],
      null,
    );
    expect(r.errors.length).toBe(8);
    expect(applyOps({ ...d0, slots: undefined }, [{ op: 'rebuild', slots: {} }], null).errors.length).toBe(1);
  });
});

describe('summarizeDesign', () => {
  it('includes text and colour tokens', () => {
    const s = summarizeDesign(buildDesign(slots('card', 'light', HEROES[1]), SIZES[0], null));
    const h = s.layers.find((l) => l.role === 'headline')!;
    expect(h.text).toBe('Cash flow without the suspense.');
    expect(h.colour).toBe('navy');
    expect(s.layers.find((l) => l.kind === 'button')!.colour).toContain('sky');
  });
});
