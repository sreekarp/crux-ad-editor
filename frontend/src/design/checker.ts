// Brand checker: every rule in CONTRACT "Brand checker rules". Each issue has a human message and fix Ops where fixable.
import type {
  ButtonLayer,
  CharmColour,
  ColourToken,
  CoreColour,
  Design,
  Issue,
  Layer,
  LogoColour,
  LogoLayer,
  Manifest,
  Op,
  RuleId,
  TextLayer,
} from '../types';
import { CORE_COLOURS, CTA_STYLES, LOGO_PILLS, MIN_FONT_PX_AT_1080, PALETTE, SAFE, TEXT_COLOURS } from '../brand';
import { measureBox, measureText } from './text';
import {
  type Box,
  behindBox,
  bounds,
  charmAspect,
  deviceInfo,
  illusInfo,
  logoAspect,
  logoOptions,
  logoPairOk,
  r1,
  samplePoints,
  snapColour,
  textOn,
} from './util';
import { CTA_FONT, CTA_HEIGHT, CTA_PAD_X, OFFER_RE } from './templates';

const COLOUR_TOKENS = Object.keys(PALETTE) as ColourToken[];
const LOGO_COLOURS: LogoColour[] = ['navy', 'sky', 'white'];
const CHARM_COLOURS: CharmColour[] = ['blue', 'green', 'yellow', 'pink', 'purple'];
const TEXTY = new Set(['text', 'button', 'logo', 'tags', 'stat']);

const fmt = (c: string) => c;

/** Points along the actual text lines (not the whole box). */
function textSamples(l: TextLayer): [number, number][] {
  const { lines } = measureBox(l.text, l.font, l.fontWeight, l.fontSize, l.letterSpacing ?? 0, l.lineHeight, l.width);
  const pts: [number, number][] = [];
  const lh = l.fontSize * l.lineHeight;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const lw = Math.min(l.width, measureText(line, l.font, l.fontWeight, l.fontSize, l.letterSpacing ?? 0));
    const x0 = l.align === 'center' ? l.x + (l.width - lw) / 2 : l.align === 'right' ? l.x + l.width - lw : l.x;
    const yc = l.y + (i + 0.5) * lh;
    for (let k = 0; k < 5; k++) {
      const x = x0 + lw * (0.06 + (0.88 * k) / 4);
      pts.push([x, yc], [x, yc - l.fontSize * 0.22], [x, yc + l.fontSize * 0.22]);
    }
  });
  return pts.length ? pts : samplePoints(l, 3, 2);
}

/** Text extents (measured height, aligned width). */
export function textExtent(l: TextLayer): Box {
  const m = measureBox(l.text, l.font, l.fontWeight, l.fontSize, l.letterSpacing ?? 0, l.lineHeight, l.width);
  return { x: l.x, y: l.y, width: l.width, height: Math.max(l.height, m.height) };
}

function layerExtent(l: Layer): { x0: number; y0: number; x1: number; y1: number } {
  if (l.kind === 'text') {
    const e = textExtent(l);
    return bounds({ ...e, rotation: l.rotation });
  }
  return bounds(l);
}

function moveInto(l: Layer, frame: { x0: number; y0: number; x1: number; y1: number }): Op | null {
  const e = layerExtent(l);
  let dx = 0;
  let dy = 0;
  if (e.x1 - e.x0 <= frame.x1 - frame.x0) {
    if (e.x0 < frame.x0) dx = frame.x0 - e.x0;
    else if (e.x1 > frame.x1) dx = frame.x1 - e.x1;
  } else dx = frame.x0 - e.x0;
  if (e.y1 - e.y0 <= frame.y1 - frame.y0) {
    if (e.y0 < frame.y0) dy = frame.y0 - e.y0;
    else if (e.y1 > frame.y1) dy = frame.y1 - e.y1;
  } else dy = frame.y0 - e.y0;
  const props: Record<string, number> = {};
  if (Math.abs(dx) > 0.01) props.x = r1(l.x + dx);
  if (Math.abs(dy) > 0.01) props.y = r1(l.y + dy);
  if (l.kind === 'text' && e.x1 - e.x0 > frame.x1 - frame.x0) {
    props.x = r1(frame.x0);
    props.width = r1(frame.x1 - frame.x0);
  }
  return Object.keys(props).length ? { op: 'update', id: l.id, props: props as Partial<Layer> } : null;
}

const inside = (e: { x0: number; y0: number; x1: number; y1: number }, f: { x0: number; y0: number; x1: number; y1: number }, tol = 1) =>
  e.x0 >= f.x0 - tol && e.y0 >= f.y0 - tol && e.x1 <= f.x1 + tol && e.y1 <= f.y1 + tol;

export function checkDesignImpl(design: Design, manifest: Manifest | null): Issue[] {
  const issues: Issue[] = [];
  const W = design.width;
  const H = design.height;
  const bg = design.background;
  const layers = design.layers.filter((l) => !l.hidden);
  const all = design.layers;
  const idx = (l: Layer) => all.indexOf(l);
  const seen = new Map<string, number>();
  const add = (rule: RuleId, severity: Issue['severity'], message: string, layerId?: string, fix?: Op[]) => {
    const key = `${rule}:${layerId ?? '*'}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    issues.push({ id: n > 1 ? `${key}:${n}` : key, rule, severity, message, ...(layerId ? { layerId } : {}), ...(fix?.length ? { fix } : {}) });
  };
  const minFont = (MIN_FONT_PX_AT_1080 * W) / 1080;
  const story = H / W > 1.6;
  const m = W * SAFE.margin;
  const name = (l: Layer) => l.role ?? l.kind;

  // palette -------------------------------------------------------------------------------
  if (!CORE_COLOURS.includes(bg)) {
    add('palette', 'error', `Background must be navy, blue, sky or white (is ${fmt(String(bg))}).`, undefined, design.slots ? [{ op: 'rebuild', slots: {} }] : undefined);
  }
  for (const l of layers) {
    const props: Record<string, string> = {};
    const bad: string[] = [];
    const chk = (key: string, v: unknown, allowed: readonly string[]) => {
      if (v === undefined || v === null) return;
      if (!allowed.includes(v as string)) {
        props[key] = snapColour(v, allowed);
        bad.push(String(v));
      }
    };
    if (l.kind === 'rect') {
      const isBg = l.role === 'bg-shape' || (l.width * l.height >= W * H * 0.5 && l.role !== 'card');
      chk('fill', l.fill, isBg ? CORE_COLOURS : COLOUR_TOKENS);
    } else if (l.kind === 'text' || l.kind === 'tags') chk('fill', l.fill, COLOUR_TOKENS);
    else if (l.kind === 'button') {
      chk('fill', l.fill, COLOUR_TOKENS);
      chk('textFill', l.textFill, COLOUR_TOKENS);
    } else if (l.kind === 'bloom') chk('colour', l.colour, COLOUR_TOKENS);
    else if (l.kind === 'bgshape') chk('colour', l.colour, CORE_COLOURS);
    else if (l.kind === 'logo') {
      chk('colour', l.colour, LOGO_COLOURS);
      if (l.pill) chk('pill', l.pill, LOGO_COLOURS);
    } else if (l.kind === 'charm') chk('colour', l.colour, CHARM_COLOURS);
    if (bad.length)
      add('palette', 'error', `${name(l)} uses off-brand colour ${bad.join(', ')} — snapping to ${Object.values(props).join(', ')}.`, l.id, [
        { op: 'update', id: l.id, props: props as Partial<Layer> },
      ]);
  }

  // text colour + contrast -----------------------------------------------------------------
  for (const l of layers) {
    if (l.kind === 'text' || l.kind === 'tags') {
      const pts = l.kind === 'text' ? textSamples(l) : samplePoints(l, 4, 2);
      const b = behindBox(all, idx(l), pts, bg);
      const want = textOn(b.colour);
      if (!(TEXT_COLOURS as string[]).includes(l.fill)) {
        add('text-colour', 'error', `Text must be navy or white (${name(l)} is ${l.fill}).`, l.id, [{ op: 'update', id: l.id, props: { fill: want } }]);
        continue;
      }
      if (b.busy) {
        add('contrast', 'warning', `${cap(name(l))} sits on a photo — move it onto a solid colour area.`, l.id);
        continue;
      }
      const needs = new Set(b.colours.map(textOn));
      if (needs.size > 1)
        add('contrast', 'warning', `${cap(name(l))} straddles light and dark areas — no single text colour passes contrast.`, l.id);
      else if (l.fill !== want)
        add('contrast', 'error', `${cap(name(l))} should be ${want} on ${b.colour}.`, l.id, [{ op: 'update', id: l.id, props: { fill: want } }]);
    } else if (l.kind === 'button') {
      if (!(TEXT_COLOURS as string[]).includes(l.textFill))
        add('text-colour', 'error', `CTA text must be navy or white (is ${l.textFill}).`, l.id, [{ op: 'update', id: l.id, props: { textFill: textOn(l.fill) } }]);
      else if (l.textFill !== textOn(l.fill))
        add('contrast', 'error', `CTA text should be ${textOn(l.fill)} on a ${l.fill} button.`, l.id, [{ op: 'update', id: l.id, props: { textFill: textOn(l.fill) } }]);
      const b = behindBox(all, idx(l), samplePoints(l, 3, 2), bg);
      if (!b.busy && b.colours.length === 1 && b.colour === l.fill) {
        const alt = (['sky', 'navy', 'white'] as const).find((c) => c !== l.fill && !(b.colour === 'navy' && c === 'navy'))!;
        add('contrast', 'error', `CTA button disappears into the ${l.fill} background.`, l.id, [
          { op: 'update', id: l.id, props: { fill: CTA_STYLES[alt].fill, textFill: CTA_STYLES[alt].textFill } as Partial<ButtonLayer> },
        ]);
      }
    }
  }

  // logo -----------------------------------------------------------------------------------
  const logos = layers.filter((l): l is LogoLayer => l.kind === 'logo');
  const A = logoAspect(manifest);
  if (logos.length === 0) {
    const w = W * 0.26;
    const h = w / A;
    const box = { x: m, y: (story ? H * (1 - SAFE.story.bottom) : H - m) - h, width: w, height: h };
    const b = behindBox(all, all.length, samplePoints(box, 5, 3), bg);
    const colour = b.busy ? 'navy' : logoOptions(b.colour)[0];
    add('logo-count', 'error', 'Every design needs exactly one Xero logo.', undefined, [
      {
        op: 'add',
        layer: { id: uniqueId(all, 'logo'), kind: 'logo', role: 'logo', colour, pill: b.busy ? 'white' : null, ...roundBox(box) },
      },
    ]);
  } else if (logos.length > 1) {
    const keep = [...logos].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    add('logo-count', 'error', `Use the logo once (found ${logos.length}).`, undefined, logos.filter((l) => l !== keep).map((l) => ({ op: 'delete', id: l.id }) as Op));
  }
  for (const l of logos) {
    const b = behindBox(all, idx(l), samplePoints(l, 6, 3, 0.06), bg);
    if (b.busy && !l.pill) {
      add('logo-pill', 'error', 'Logo over a photo needs the pill (white pill + navy logo).', l.id, [{ op: 'update', id: l.id, props: { pill: 'white', colour: 'navy' } }]);
    } else if (l.pill) {
      if (!logoPairOk(l.pill, l.colour)) {
        const pair = LOGO_PILLS.find((p) => p.pill === l.pill) ?? LOGO_PILLS[0];
        add('logo-pill', 'error', `Pill colours must be white+navy, navy+sky or sky+navy (is ${l.pill}+${l.colour}).`, l.id, [
          { op: 'update', id: l.id, props: { pill: pair.pill, colour: pair.colour } },
        ]);
      }
    } else {
      const allowed = b.colours.length ? logoOptions(b.colours[0]).filter((c) => b.colours.every((k) => logoOptions(k).includes(c))) : [];
      if (!allowed.length)
        add('logo-colour', 'error', 'Logo straddles two background colours — use the pill or move it.', l.id, [
          { op: 'update', id: l.id, props: { pill: 'white', colour: 'navy' } },
        ]);
      else if (!allowed.includes(l.colour))
        add('logo-colour', 'error', `Logo should be ${allowed.join(' or ')} on ${b.colour}.`, l.id, [{ op: 'update', id: l.id, props: { colour: allowed[0] } }]);
    }
    const asp = l.width / Math.max(1e-6, l.height);
    if (Math.abs(asp - A) / A > 0.05) {
      const h = l.width / A;
      add('logo-aspect', 'error', 'Logo is stretched — restore its proportions.', l.id, [
        { op: 'update', id: l.id, props: { height: r1(h), y: r1(l.y + (l.height - h) / 2) } },
      ]);
    }
  }

  // CTA count --------------------------------------------------------------------------------
  const ctas = layers.filter((l): l is ButtonLayer => l.kind === 'button');
  if (ctas.length === 0) {
    const text = design.slots?.cta ?? 'Find out more';
    const fs = r1(W * CTA_FONT);
    const w = r1(measureText(text, 'body', 700, fs, 0) + 2 * W * CTA_PAD_X);
    const h = r1(W * CTA_HEIGHT);
    const y = story ? H * (1 - SAFE.story.bottom) - h - W * 0.12 : H - m - h - W * 0.12;
    const b = behindBox(all, all.length, samplePoints({ x: m, y, width: w, height: h }), bg);
    const style = b.colour === 'navy' || b.colour === 'blue' ? CTA_STYLES.sky : CTA_STYLES.navy;
    add('cta-count', 'error', 'Add exactly one call-to-action button.', undefined, [
      {
        op: 'add',
        layer: { id: uniqueId(all, 'cta'), kind: 'button', role: 'cta', text, fill: style.fill, textFill: style.textFill, fontSize: fs, cornerRadius: r1(W * 0.012), x: r1(m), y: r1(y), width: w, height: h },
      },
    ]);
  } else if (ctas.length > 1) {
    // A soft style default (every reference ad has one CTA), not a brand rule: warn, never auto-delete what the user added.
    add('cta-count', 'warning', `${ctas.length} buttons — a single call to action usually works best.`, ctas[1].id);
  }

  // headline copy ----------------------------------------------------------------------------
  const headline = layers.find((l): l is TextLayer => l.kind === 'text' && l.role === 'headline');
  if (headline) {
    const words = headline.text.split(/\s+/).filter(Boolean).length;
    if (words > 10) add('headline-length', 'warning', `Headline has ${words} words — keep it to 10 or fewer.`, headline.id);
    const t = headline.text.trim().replace(/[*”’"')\]]+$/, '');
    if (!/[.?!]$/.test(t))
      add('headline-punctuation', 'warning', 'Headline should end with a full stop or question mark.', headline.id, [
        { op: 'update', id: headline.id, props: { text: insertFullStop(headline.text) } },
      ]);
  }

  // layout: margins, 9:16 safe zone, off-canvas ---------------------------------------------
  const frame = { x0: m, y0: m, x1: W - m, y1: H - m };
  const storyFrame = { x0: W * SAFE.story.side, y0: H * SAFE.story.top, x1: W * (1 - SAFE.story.side), y1: H * (1 - SAFE.story.bottom) };
  for (const l of layers) {
    if (!TEXTY.has(l.kind)) continue;
    const e = layerExtent(l);
    if (l.kind === 'text' || l.kind === 'button') {
      if (!inside(e, { x0: 0, y0: 0, x1: W, y1: H }, 0.5)) {
        const op = moveInto(l, story ? storyFrame : frame);
        add('off-canvas', 'error', `${cap(name(l))} runs off the canvas.`, l.id, op ? [op] : undefined);
        continue;
      }
    }
    if (l.kind === 'stat') continue; // stat cards may overlap the photo edge, but stay on canvas
    if (story) {
      const br = { x0: W * (1 - SAFE.story.bottomRightW), y0: H * (1 - SAFE.story.bottomRightH) };
      const inBR = e.x1 > br.x0 + 1 && e.y1 > br.y0 + 1;
      if (!inside(e, storyFrame) || inBR) {
        let op = moveInto(l, storyFrame);
        if (inBR && (!op || op.op !== 'update')) op = { op: 'update', id: l.id, props: { y: r1(l.y - (e.y1 - br.y0)) } };
        else if (inBR && op && op.op === 'update') {
          const ny = (op.props.y ?? l.y) as number;
          const ne = e.y1 + (ny - l.y);
          if (ne > br.y0) op.props.y = r1(ny - (ne - br.y0));
        }
        add('safe-zone-916', 'error', `${cap(name(l))} is outside the 9:16 safe zone (top 14%, bottom 35%, bottom-right corner).`, l.id, op ? [op] : undefined);
      }
    } else if (!inside(e, frame)) {
      const op = moveInto(l, frame);
      add('safe-margin', 'warning', `${cap(name(l))} is inside the 6% margin.`, l.id, op ? [op] : undefined);
    }
  }

  // min font size --------------------------------------------------------------------------
  for (const l of layers) {
    if ((l.kind === 'text' || l.kind === 'button' || l.kind === 'tags') && l.fontSize < minFont - 0.5) {
      const props: Record<string, number> = { fontSize: r1(minFont) };
      if (l.kind === 'text') {
        const mb = measureBox(l.text, l.font, l.fontWeight, minFont, l.letterSpacing ?? 0, l.lineHeight, l.width);
        props.height = r1(mb.height);
      }
      add('min-font-size', 'error', `${cap(name(l))} text is ${Math.round(l.fontSize)}px — minimum is ${Math.round(minFont)}px.`, l.id, [
        { op: 'update', id: l.id, props: props as Partial<Layer> },
      ]);
    }
  }

  // disclaimer -----------------------------------------------------------------------------
  const copy = layers.filter((l) => (l.kind === 'text' && ['headline', 'headline2', 'sub'].includes(l.role ?? '')) || l.kind === 'button');
  const offer = copy.find((l) => OFFER_RE.test((l as TextLayer | ButtonLayer).text));
  const hasDisc = layers.some((l) => l.kind === 'text' && (l.role === 'disclaimer' || /terms apply|^\s*\*/i.test(l.text)));
  if (offer && !hasDisc) {
    add('disclaimer', 'error', 'Offer copy (%, price, free, voucher, off, *) needs a disclaimer such as "Terms apply."', offer.id, [
      { op: 'add', layer: disclaimerFor(design, ctas[0] ?? null) },
    ]);
  }

  // photo treatment ------------------------------------------------------------------------
  for (const l of layers) {
    if (l.kind !== 'photo' || l.mask) continue;
    const e = bounds(l);
    const edges = [e.x0 <= 1, e.y0 <= 1, e.x1 >= W - 1, e.y1 >= H - 1].filter(Boolean).length;
    if ((l.cornerRadius ?? 0) < W * 0.02 - 0.01 && edges < 2)
      add('photo-treatment', 'error', 'Photos need a bloom mask or rounded corners (never a plain rectangle).', l.id, [
        { op: 'update', id: l.id, props: { cornerRadius: r1(W * 0.04) } },
      ]);
  }

  // bloom colours (max 3) ------------------------------------------------------------------
  const blooms = layers.filter((l) => l.kind === 'bloom' || l.kind === 'bgshape') as (Layer & { colour: ColourToken })[];
  const counts = new Map<string, number>();
  blooms.forEach((b) => counts.set(b.colour, (counts.get(b.colour) ?? 0) + 1));
  if (counts.size > 3) {
    const order = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const keep = new Set(order.slice(0, 3));
    const target = order[0] as CoreColour;
    add(
      'bloom-colours',
      'warning',
      `Blooms use ${counts.size} colours — limit to 3.`,
      undefined,
      blooms.filter((b) => !keep.has(b.colour)).map((b) => ({ op: 'update', id: b.id, props: { colour: b.kind === 'bgshape' ? (CORE_COLOURS.includes(target) ? target : 'blue') : target } }) as Op),
    );
  }

  // aspect (charms, devices, illustrations not stretched) ----------------------------------
  for (const l of layers) {
    let a: number | null = null;
    if (l.kind === 'charm') a = charmAspect(l.charm, manifest);
    else if (l.kind === 'image' && (l.role === 'device' || l.role === 'illustration')) {
      const id = l.assetId ?? '';
      if (l.role === 'device') a = id ? deviceInfo(id, manifest).aspect : null;
      else a = id ? illusInfo(id, manifest).aspect : null;
      if (manifest && id && !manifest.devices?.some((d) => d.id === id) && !manifest.illustrations?.some((d) => d.id === id)) a = null;
    }
    if (!a) continue;
    const asp = l.width / Math.max(1e-6, l.height);
    if (Math.abs(asp - a) / a > 0.05) {
      const h = l.width / a;
      add('aspect', 'error', `${cap(name(l))} is stretched — keep its original proportions.`, l.id, [
        { op: 'update', id: l.id, props: { height: r1(h), y: r1(l.y + (l.height - h) / 2) } },
      ]);
    }
  }
  return issues;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).replace('-', ' ');
}

function insertFullStop(text: string): string {
  const m = text.match(/^(.*?)([*”’"')\]\s]*)$/s);
  const body = (m?.[1] ?? text).replace(/[,;:\s]+$/, '');
  return `${body}.${(m?.[2] ?? '').trim()}`;
}

function roundBox(b: Box): Box {
  return { x: r1(b.x), y: r1(b.y), width: r1(b.width), height: r1(b.height) };
}

export function uniqueId(layers: Layer[], role: string): string {
  let n = 1;
  const ids = new Set(layers.map((l) => l.id));
  while (ids.has(`${role}-${n}`)) n++;
  return `${role}-${n}`;
}

function disclaimerFor(design: Design, cta: ButtonLayer | null): TextLayer {
  const W = design.width;
  const H = design.height;
  const m = W * SAFE.margin;
  const fs = r1(Math.max((MIN_FONT_PX_AT_1080 * W) / 1080, W * 0.026));
  const h = r1(fs * 1.25);
  const story = H / W > 1.6;
  const yMax = (story ? H * (1 - SAFE.story.bottom) : H - m) - h;
  let x = m;
  let y = yMax;
  if (cta) {
    x = cta.x;
    y = cta.y + cta.height + W * 0.02;
    if (y > yMax) y = cta.y - h - W * 0.02;
  }
  const w = r1(Math.min(W - m - x, W * 0.5));
  const box = { x: r1(x), y: r1(y), width: w, height: h };
  const b = behindBox(design.layers, design.layers.length, samplePoints(box, 4, 1), design.background);
  return {
    id: uniqueId(design.layers, 'disclaimer'),
    kind: 'text',
    role: 'disclaimer',
    text: 'Terms apply.',
    font: 'body',
    fontSize: fs,
    fontWeight: 500,
    fill: textOn(b.colour),
    align: 'left',
    lineHeight: 1.25,
    letterSpacing: 0,
    ...box,
  };
}

/** 0-100. */
export function brandScoreImpl(issues: Issue[]): number {
  return Math.max(0, 100 - issues.reduce((s, i) => s + (i.severity === 'error' ? 15 : 5), 0));
}
