// Aim photo crops at the subject: bank photos carry a focus point (main face, from backend/scripts/bank_focus.py).
// The layer also remembers the subject + source size, so the design engine can re-frame it after any layout change
// (see design/frame.ts).
import { frameSubject } from '../design/frame';
import { fitPhotoLayer, keepDecorOffFaces, photoVisibleRect } from '../design/photoFit';
import type { Design, Layer, Op, PhotoBankItem, PhotoLayer } from '../types';

type FocusProps = Partial<Pick<PhotoLayer, 'focusX' | 'focusY' | 'zoom' | 'subject' | 'subjectBox' | 'srcW' | 'srcH'>>;
type SubjectBox = [number, number, number, number];

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** /api/photo shape hints for a layer, so the backend composes the subject where it will actually be seen:
 *  - aspect = the layer BOX w/h. The renderer cover-fits the image over the whole box (canvas/photo.ts, zoom >= 1,
 *    focus 0.5 by default), so with the box aspect the backend can map box fractions onto the generated image exactly
 *    (it picks the nearest generation size and maps `region` through the same centred cover-fit). A "portrait for
 *    blooms" aspect would break that mapping, so the box aspect always wins.
 *  - region = photoVisibleRect(layer, design) as box fractions [x0, y0, x1, y1]: the part of the box left visible by
 *    the bloom mask / canvas edge / layers drawn above (pass the Design to count those). The subject must sit there.
 *  - fit = kind of shape (bloom mask, rounded frame, full-bleed box).
 *  {} for non-photo layers; a field is left out when it cannot be computed. */
export function photoShape(
  layer: Layer | undefined,
  design?: Design,
): { aspect?: number; fit?: 'bloom' | 'frame' | 'full'; region?: SubjectBox } {
  if (!layer || layer.kind !== 'photo') return {};
  const aspect = layer.width > 0 && layer.height > 0 ? layer.width / layer.height : NaN;
  let region: SubjectBox | null = null;
  try {
    const v = photoVisibleRect(layer, design);
    const [x0, y0, x1, y1] = v.map((n) => r3(c01(n)));
    if (v.every(Number.isFinite) && x1 > x0 && y1 > y0) region = [x0, y0, x1, y1];
  } catch (e) {
    console.warn('[photoShape]', e);
  }
  return {
    ...(Number.isFinite(aspect) && aspect > 0 ? { aspect: r3(aspect) } : {}),
    fit: layer.mask ? 'bloom' : (layer.cornerRadius ?? 0) > 0 ? 'frame' : 'full',
    ...(region ? { region } : {}),
  };
}

/** Shape-aware placement for a photo layer (box-aware re-crop, else a better-fitting chunky bloom), or null when the
 *  layer has no subject box (then nothing may change) or the engine failed. */
export function photoFitProps(design: Design, layerId: string): { props: Partial<PhotoLayer>; coverage: number; needsRegenerate: boolean } | null {
  const l = design.layers.find((x) => x.id === layerId);
  if (!l || l.kind !== 'photo' || !l.subjectBox) return null;
  try {
    return fitPhotoLayer(design, layerId);
  } catch (e) {
    console.warn('[photoFit]', e);
    return null;
  }
}

/** Would `p` change the photo's crop (focus / zoom) or bloom mask? */
export function cropChanged(a: PhotoLayer, p: Partial<PhotoLayer> | null | undefined): boolean {
  if (!p) return false;
  const num = (k: 'focusX' | 'focusY' | 'zoom') => typeof p[k] === 'number' && Math.abs((p[k] as number) - a[k]) > 1e-3;
  return num('focusX') || num('focusY') || num('zoom') || (p.mask !== undefined && p.mask !== a.mask);
}

/** Photo layers that a list of ops asks to re-crop (reframe ops; a reframe without id = every photo). */
export function reframeTargets(d: Design, ops: Op[]): string[] {
  const photos = d.layers.filter((l) => l.kind === 'photo').map((l) => l.id);
  const ids = new Set<string>();
  for (const o of ops) if (o.op === 'reframe') (o.id ? [o.id] : photos).forEach((x) => ids.add(x));
  return [...ids].filter((x) => photos.includes(x));
}

const c01 = (v: number) => Math.min(1, Math.max(0, v));

/** A usable subject box (x0, y0, x1, y1 source fractions, clamped), or null. */
export function cleanBox(b: unknown): SubjectBox | null {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const [x0, y0, x1, y1] = (b as number[]).map(c01);
  return x1 - x0 > 0.01 && y1 - y0 > 0.01 ? [x0, y0, x1, y1] : null;
}

/** Face point when only the box is known: centred, in the upper part of the subject (the head). */
const boxPoint = (b: SubjectBox): [number, number] => [(b[0] + b[2]) / 2, b[1] + 0.15 * (b[3] - b[1])];

/** The layer's previous subject box is stale once the photo changes: clear it unless a new one is set. */
const staleBox = (layer: PhotoLayer): FocusProps => (layer.subjectBox ? { subjectBox: null } : {});

/** Crop + subject props for a photo layer showing `url` (empty when the photo has no known subject). */
export function focusProps(layer: PhotoLayer, design: Design, url: string | null | undefined, photos: PhotoBankItem[]): FocusProps {
  const item = url ? photos.find((p) => p.url === url) : undefined;
  const box = cleanBox(item?.box);
  const point = item?.focus ?? (box ? boxPoint(box) : null);
  if (!item || !point || !item.w || !item.h) return staleBox(layer);
  const f = frameSubject({ ...layer, zoom: 1 }, design, point, { w: item.w, h: item.h }, box ?? undefined);
  return { ...f, subject: point, ...(box ? { subjectBox: box } : staleBox(layer)), srcW: item.w, srcH: item.h };
}

/** Crop + subject props for a freshly generated photo (/api/photo result with a focus point and/or subject box).
 *  Without either, a layer that still carries the previous photo's subject is reset to a centred crop (stale). */
export function focusPropsFromResult(
  layer: PhotoLayer,
  design: Design,
  r: { focus?: [number, number] | null; box?: SubjectBox | null; w?: number; h?: number } | null | undefined,
): FocusProps {
  const f = r?.focus;
  const box = cleanBox(r?.box);
  const point: [number, number] | null =
    f && f.length === 2 && Number.isFinite(f[0]) && Number.isFinite(f[1]) ? [c01(f[0]), c01(f[1])] : box ? boxPoint(box) : null;
  if (point && r?.w && r?.h) {
    const framing = frameSubject({ ...layer, zoom: 1 }, design, point, { w: r.w, h: r.h }, box ?? undefined);
    return { ...framing, subject: point, ...(box ? { subjectBox: box } : staleBox(layer)), srcW: r.w, srcH: r.h };
  }
  return layer.subject ? { focusX: 0.5, focusY: 0.5, zoom: 1, subject: null, ...staleBox(layer) } : staleBox(layer);
}

/** Frames every photo layer whose src is a bank photo with a known subject position, then keeps charms / stat cards
 *  off the framed subjects' heads (the build path's layout guard: buildDesign alone doesn't know the subject yet). */
export function withPhotoFocus(design: Design, photos: PhotoBankItem[]): Design {
  let changed = false;
  const layers = design.layers.map((l): Layer => {
    if (l.kind !== 'photo' || !l.src) return l;
    const props = focusProps(l, design, l.src, photos);
    if (!('focusX' in props)) return l;
    changed = true;
    return { ...l, ...props };
  });
  return changed ? keepDecorOffFaces({ ...design, layers }) : design;
}
