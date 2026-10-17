// Ops engine: the only way the copilot changes a design (CONTRACT "Ops semantics"). Pure; invalid ops -> errors.
import type { AsyncOp, ButtonLayer, Design, Layer, Manifest, Op, PhotoLayer, Slots, TextLayer } from '../types';
import { reframePhoto } from './frame';
import { fitPhotoLayer, keepDecorOffFaces } from './photoFit';
import { buildDesignImpl } from './templates';
import { measureBox, measureText } from './text';
import { r1 } from './util';

const KINDS = new Set(['rect', 'text', 'button', 'logo', 'bloom', 'bgshape', 'charm', 'image', 'photo', 'tags', 'stat']);
const NUMERIC = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'fontSize', 'lineHeight', 'letterSpacing', 'cornerRadius', 'zoom', 'focusX', 'focusY', 'fontWeight'];

const SLOT_ROLES: Partial<Record<string, 'headline' | 'headline2' | 'sub' | 'cta' | 'disclaimer'>> = {
  headline: 'headline',
  headline2: 'headline2',
  sub: 'sub',
  cta: 'cta',
  disclaimer: 'disclaimer',
};
const GEOMETRY = ['x', 'y', 'width', 'height', 'fontSize', 'rotation'];
const flatText = (t: string) => t.replace(/\s*\n\s*/g, ' ').trim();

/** True when the design still has the template's geometry (nobody moved/resized layers by hand). */
function layoutUntouched(d: Design, manifest: Manifest | null): boolean {
  if (!d.slots) return false;
  let fresh: Design;
  try {
    fresh = rebuild(d, {}, { width: d.width, height: d.height }, manifest);
  } catch {
    return false;
  }
  if (fresh.layers.length !== d.layers.length) return false;
  const byId = new Map(fresh.layers.map((l) => [l.id, l]));
  return d.layers.every((l) => {
    const f = byId.get(l.id);
    return (
      !!f &&
      f.kind === l.kind &&
      Math.abs(f.x - l.x) < 1.5 &&
      Math.abs(f.y - l.y) < 1.5 &&
      Math.abs(f.width - l.width) < 1.5 &&
      Math.abs(f.height - l.height) < 1.5
    );
  });
}

/** Hand-edited layouts: push the layers stacked below a text box that grew (or shrank), and grow its card. */
function restack(d: Design, prev: Layer, next: Layer) {
  if (next.kind !== 'text' || prev.kind !== 'text') return;
  const delta = next.height - prev.height;
  if (Math.abs(delta) < 0.5) return;
  const oldBottom = prev.y + prev.height;
  d.layers = d.layers.map((l) => {
    if (l.id === next.id) return l;
    const xOverlap = l.x < prev.x + prev.width && l.x + l.width > prev.x;
    if (!xOverlap) return l;
    if (l.kind === 'rect' && l.role === 'card' && l.y <= prev.y && l.y + l.height >= oldBottom - 1)
      return { ...l, height: r1(l.height + delta) };
    if ((l.kind === 'text' || l.kind === 'button' || l.kind === 'tags') && l.y >= oldBottom - 2) return { ...l, y: r1(l.y + delta) };
    return l;
  });
}

function uniqueId(layers: Layer[], base: string): string {
  const ids = new Set(layers.map((l) => l.id));
  let n = 1;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Keep text boxes / buttons sized to their content after copy or font edits. */
function reflow(prev: Layer, next: Layer, props: Record<string, unknown>) {
  if (next.kind === 'text' && prev.kind === 'text') {
    const touched = ['text', 'fontSize', 'width', 'lineHeight', 'letterSpacing', 'font', 'fontWeight'].some((k) => k in props);
    if (touched && !('height' in props)) {
      const t = next as TextLayer;
      t.height = r1(measureBox(t.text, t.font, t.fontWeight, t.fontSize, t.letterSpacing ?? 0, t.lineHeight, t.width).height);
    }
  }
  if (next.kind === 'button' && prev.kind === 'button') {
    const b = next as ButtonLayer;
    if (('text' in props || 'fontSize' in props) && !('width' in props)) {
      const pad = Math.max(prev.width - measureText(prev.text, 'body', 700, prev.fontSize, 0), 0) / 2;
      b.width = r1(measureText(b.text, 'body', 700, b.fontSize, 0) + 2 * pad);
    }
  }
}

/** Slots synced from the current layers, so a rebuild keeps the user's edits where the slot is unchanged. */
function carryEdits(d: Design, next: Slots, changed: Partial<Slots>) {
  const byRole = (role: string) => d.layers.find((l) => l.role === role);
  const flat = (t: string) => t.replace(/\s*\n\s*/g, ' ').trim();
  for (const key of ['headline', 'headline2', 'sub', 'disclaimer'] as const) {
    if (key in changed) continue;
    const l = byRole(key);
    if (l && l.kind === 'text' && flat(l.text)) next[key] = flat(l.text);
  }
  if (!('cta' in changed)) {
    const c = d.layers.find((l) => l.kind === 'button');
    if (c && c.kind === 'button' && c.text.trim()) next.cta = c.text.trim();
  }
  if (!('items' in changed)) {
    const rows = d.layers.filter((l): l is TextLayer => l.kind === 'text' && l.role === 'row-text').map((l) => flat(l.text));
    if (rows.length) next.items = rows;
  }
  if (!('stat' in changed)) {
    const s = d.layers.find((l) => l.kind === 'stat');
    if (s && s.kind === 'stat' && next.stat) next.stat = { label: s.label, value: s.value, variant: s.variant };
  }
  const heroChanged = 'hero' in changed && changed.hero && ('photoUrl' in changed.hero || (changed.hero.type && changed.hero.type !== d.slots?.hero?.type));
  if (!heroChanged && next.hero?.type === 'photo') {
    const p = d.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.role === 'photo');
    if (p?.src) next.hero = { ...next.hero, photoUrl: p.src };
  }
}

/** Layers that carry the message: decoration must never be drawn over them. */
const CONTENT_KINDS = new Set<Layer['kind']>(['text', 'button', 'logo', 'tags', 'stat']);
const overlaps = (a: Layer, b: Layer) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Where a newly added layer goes in the stack (when the op gives no index). Blooms/background shapes sit behind all
 *  copy, logo and buttons; a charm that overlaps copy goes behind the first piece of copy it touches. Others: on top. */
function decorIndex(layers: Layer[], added: Layer): number {
  if (added.kind === 'bloom' || added.kind === 'bgshape') {
    const i = layers.findIndex((l) => CONTENT_KINDS.has(l.kind));
    return i < 0 ? layers.length : i;
  }
  if (added.kind === 'charm') {
    const i = layers.findIndex((l) => CONTENT_KINDS.has(l.kind) && overlaps(added, l));
    return i < 0 ? layers.length : i;
  }
  return layers.length;
}

function rebuild(d: Design, changed: Partial<Slots>, size: { width: number; height: number }, manifest: Manifest | null): Design {
  const prev = d.slots!;
  const hero = changed.hero
    ? !changed.hero.type || changed.hero.type === prev.hero?.type
      ? { ...prev.hero, ...changed.hero }
      : changed.hero
    : prev.hero;
  const next: Slots = { ...prev, ...changed, hero } as Slots;
  carryEdits(d, next, changed);
  const built = buildDesignImpl(next, size, manifest, { id: d.id, name: d.name });
  // keep photo status/prompt/framing edits on the rebuilt photo
  const oldPhoto = d.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.role === 'photo');
  const newPhoto = built.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.role === 'photo');
  if (oldPhoto && newPhoto && oldPhoto.src && oldPhoto.src === newPhoto.src) {
    newPhoto.status = oldPhoto.status ?? newPhoto.status;
    if (oldPhoto.prompt) newPhoto.prompt = oldPhoto.prompt;
    if ((oldPhoto.subject || oldPhoto.subjectBox) && oldPhoto.srcW && oldPhoto.srcH) {
      // New layout = new photo frame: re-aim the crop at the person instead of copying the old frame's crop.
      Object.assign(newPhoto, { ...(oldPhoto.subject ? { subject: oldPhoto.subject } : {}), srcW: oldPhoto.srcW, srcH: oldPhoto.srcH });
      if (oldPhoto.subjectBox) {
        // Shape-aware: keep the essential region in view, re-choosing a better chunky mask when this template's mask
        // cuts it (so a mask fitPhotoLayer picked survives "make it dark" and other rebuilds).
        newPhoto.subjectBox = oldPhoto.subjectBox;
        Object.assign(newPhoto, fitPhotoLayer(built, newPhoto.id).props);
      } else {
        Object.assign(newPhoto, reframePhoto(newPhoto, built));
      }
    } else {
      newPhoto.zoom = oldPhoto.zoom;
      newPhoto.focusX = oldPhoto.focusX;
      newPhoto.focusY = oldPhoto.focusY;
    }
  }
  // The crop is final only now: move charms / stat cards the template placed on the subject's head.
  return keepDecorOffFaces(built);
}

function scaleDesign(d: Design, width: number, height: number): Design {
  const sx = width / d.width;
  const sy = height / d.height;
  const s = Math.min(sx, sy);
  const layers = d.layers.map((l) => {
    const n = { ...l } as Layer & Record<string, unknown>;
    const fullBleed = (l.kind === 'rect' || l.kind === 'bgshape' || l.kind === 'photo') && l.width >= d.width * 0.95;
    const cx = (l.x + l.width / 2) * sx;
    const cy = (l.y + l.height / 2) * sy;
    if (fullBleed) {
      n.x = r1(l.x * sx);
      n.y = r1(l.y * sy);
      n.width = r1(l.width * sx);
      n.height = r1(l.height * sy);
    } else {
      n.width = r1(l.width * s);
      n.height = r1(l.height * s);
      n.x = r1(cx - (l.width * s) / 2);
      n.y = r1(cy - (l.height * s) / 2);
    }
    for (const k of ['fontSize', 'cornerRadius', 'letterSpacing'] as const) if (typeof n[k] === 'number') n[k] = r1((n[k] as number) * s);
    return n as Layer;
  });
  return { ...d, width, height, layers };
}

export function applyOpsImpl(
  design: Design,
  ops: Op[],
  manifest: Manifest | null,
): { design: Design; pending: AsyncOp[]; errors: string[] } {
  let d: Design = { ...design, layers: design.layers.map((l) => ({ ...l }) as Layer) };
  const pending: AsyncOp[] = [];
  const errors: string[] = [];
  if (!Array.isArray(ops)) return { design: d, pending, errors: ['ops must be an array'] };
  for (const op of ops) {
    try {
      if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') {
        errors.push(`invalid op: ${JSON.stringify(op)}`);
        continue;
      }
      switch (op.op) {
        case 'update': {
          const i = d.layers.findIndex((l) => l.id === op.id);
          if (i < 0) {
            errors.push(`update: no layer "${op.id}"`);
            break;
          }
          if (!op.props || typeof op.props !== 'object') {
            errors.push(`update ${op.id}: props must be an object`);
            break;
          }
          const props: Record<string, unknown> = { ...op.props };
          delete props.id;
          delete props.kind;
          for (const k of NUMERIC) {
            if (k in props && (typeof props[k] !== 'number' || !Number.isFinite(props[k] as number))) {
              errors.push(`update ${op.id}: ${k} must be a number`);
              delete props[k];
            }
          }
          for (const k of ['width', 'height'] as const) {
            if (k in props && (props[k] as number) <= 0) {
              errors.push(`update ${op.id}: ${k} must be > 0`);
              delete props[k];
            }
          }
          const prev = d.layers[i];
          const next = { ...prev, ...props } as Layer;
          reflow(prev, next, props);
          if (next.kind === 'photo' && prev.kind === 'photo') {
            // A different image invalidates the stored subject (unless the caller sent the new one).
            if ('src' in props && props.src !== prev.src) {
              if (!('subject' in props)) delete next.subject;
              if (!('subjectBox' in props)) delete next.subjectBox; // never keep the old photo's subject box
              if (!('subject' in props) && !('subjectBox' in props)) {
                delete next.srcW;
                delete next.srcH;
              }
            }
            // Moving/resizing/re-masking the frame keeps the person in view unless the crop itself was set explicitly.
            const moved = GEOMETRY.some((k) => k in props) || 'mask' in props;
            const framed = 'focusX' in props || 'focusY' in props || 'zoom' in props;
            if (moved && !framed) Object.assign(next, reframePhoto(next, d));
          }
          // A photo landing (new src / subject) or a computed fit (mask + crop together) moves the head: keep decor
          // off it. Plain user drags and crop tweaks never move charms.
          const photoLanded =
            next.kind === 'photo' &&
            prev.kind === 'photo' &&
            (('src' in props && props.src !== prev.src) || 'subject' in props || 'subjectBox' in props || ('mask' in props && ('focusX' in props || 'focusY' in props || 'zoom' in props)));
          // Copy edits on slot-backed text (headline, sub, CTA...) re-run the template so everything below restacks.
          const slotKey = prev.role ? SLOT_ROLES[prev.role] : undefined;
          const textChanged =
            typeof props.text === 'string' && (prev.kind === 'text' || prev.kind === 'button') && props.text !== prev.text;
          if (textChanged && slotKey && d.slots && !GEOMETRY.some((k) => k in props) && layoutUntouched(d, manifest)) {
            const rebuilt = rebuild(d, { [slotKey]: flatText(props.text as string) } as Partial<Slots>, { width: d.width, height: d.height }, manifest);
            const extra: Record<string, unknown> = { ...props };
            for (const k of ['text', ...GEOMETRY]) delete extra[k];
            const j = rebuilt.layers.findIndex((l) => l.id === prev.id);
            if (j >= 0 && Object.keys(extra).length) rebuilt.layers[j] = { ...rebuilt.layers[j], ...extra } as Layer;
            d = rebuilt;
            break;
          }
          d.layers[i] = next;
          restack(d, prev, next);
          if (photoLanded) d = keepDecorOffFaces(d);
          break;
        }
        case 'add': {
          const l = op.layer as Layer | undefined;
          if (!l || typeof l !== 'object' || !KINDS.has((l as Layer).kind)) {
            errors.push(`add: invalid layer kind "${(l as Layer | undefined)?.kind}"`);
            break;
          }
          const bad = ['x', 'y', 'width', 'height'].filter((k) => typeof (l as unknown as Record<string, unknown>)[k] !== 'number');
          if (bad.length) {
            errors.push(`add: layer needs numeric ${bad.join(', ')}`);
            break;
          }
          const layer = { ...l } as Layer;
          if (!layer.id || d.layers.some((x) => x.id === layer.id)) layer.id = uniqueId(d.layers, layer.role ?? layer.kind);
          const at = op.index === undefined ? decorIndex(d.layers, layer) : Math.max(0, Math.min(d.layers.length, Math.round(op.index)));
          d.layers.splice(at, 0, layer);
          // Keep slots in sync so a later rebuild/resize keeps the added charm.
          if (d.slots && layer.kind === 'charm') {
            d.slots = { ...d.slots, charms: [...(d.slots.charms ?? []), { charm: layer.charm, colour: layer.colour }] };
          }
          break;
        }
        case 'reframe': {
          const targets = d.layers.filter((l): l is PhotoLayer => l.kind === 'photo' && (!op.id || l.id === op.id));
          if (!targets.length) {
            errors.push(`reframe: no photo layer${op.id ? ` "${op.id}"` : ''}`);
            break;
          }
          for (const p of targets) {
            if (!p.subject && !p.subjectBox) {
              errors.push(`reframe ${p.id}: subject position unknown`);
              continue;
            }
            // Shape-aware: with a subject box this fits the whole essential region (and may swap to a better bloom
            // mask); without one it is exactly reframePhoto.
            d.layers[d.layers.indexOf(p)] = { ...p, ...fitPhotoLayer(d, p.id).props };
          }
          d = keepDecorOffFaces(d);
          break;
        }
        case 'delete': {
          const i = d.layers.findIndex((l) => l.id === op.id);
          if (i < 0) {
            errors.push(`delete: no layer "${op.id}"`);
            break;
          }
          const [removed] = d.layers.splice(i, 1);
          // Keep slots in sync so a later rebuild/resize doesn't resurrect what the user removed.
          if (d.slots) {
            const s = { ...d.slots };
            if (removed.role === 'stat') s.stat = null;
            else if (removed.role === 'tags') s.tags = false;
            else if (removed.role === 'sub') s.sub = null;
            else if (removed.role === 'disclaimer') s.disclaimer = null;
            else if (removed.role === 'headline2') s.headline2 = null;
            else if (removed.kind === 'charm') {
              const k = (s.charms ?? []).findIndex((c) => c.charm === removed.charm && c.colour === removed.colour);
              if (k >= 0) s.charms = (s.charms ?? []).filter((_, j) => j !== k);
            } else if (removed.role === 'photo' || removed.role === 'device' || removed.role === 'illustration') {
              s.hero = { type: 'none' };
            }
            d.slots = s;
          }
          break;
        }
        case 'reorder': {
          const i = d.layers.findIndex((l) => l.id === op.id);
          if (i < 0) {
            errors.push(`reorder: no layer "${op.id}"`);
            break;
          }
          const [l] = d.layers.splice(i, 1);
          const to =
            op.to === 'front' ? d.layers.length : op.to === 'back' ? 0 : op.to === 'forward' ? Math.min(d.layers.length, i + 1) : op.to === 'backward' ? Math.max(0, i - 1) : -1;
          if (to < 0) {
            d.layers.splice(i, 0, l);
            errors.push(`reorder: invalid target "${op.to}"`);
          } else d.layers.splice(to, 0, l);
          break;
        }
        case 'rebuild': {
          if (!d.slots) {
            errors.push('rebuild: design has no slots');
            break;
          }
          d = rebuild(d, (op.slots ?? {}) as Partial<Slots>, { width: d.width, height: d.height }, manifest);
          break;
        }
        case 'resize': {
          const { width, height } = op;
          if (!(typeof width === 'number' && typeof height === 'number' && width >= 100 && height >= 100 && width <= 8000 && height <= 8000)) {
            errors.push(`resize: invalid size ${width}x${height}`);
            break;
          }
          d = d.slots ? rebuild(d, {}, { width, height }, manifest) : keepDecorOffFaces(scaleDesign(d, width, height));
          break;
        }
        case 'photo':
        case 'pixel_edit': {
          const i = d.layers.findIndex((l) => l.id === op.id);
          const l = d.layers[i];
          if (!l || (l.kind !== 'photo' && l.kind !== 'image')) {
            errors.push(`${op.op}: no photo/image layer "${op.id}"`);
            break;
          }
          if (typeof op.prompt !== 'string' || !op.prompt.trim()) {
            errors.push(`${op.op}: prompt required`);
            break;
          }
          if (op.op === 'photo' && l.kind === 'photo') d.layers[i] = { ...l, status: 'loading', prompt: op.prompt };
          pending.push(op);
          break;
        }
        default:
          errors.push(`unknown op "${(op as { op: string }).op}"`);
      }
    } catch (e) {
      errors.push(`${(op as Op).op}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { design: d, pending, errors };
}
