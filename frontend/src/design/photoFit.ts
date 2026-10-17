// Shape-aware photo placement (pure). Keeps a photo's essential subject region (layer.subjectBox: what must stay visible
// for the crop to look good, always the whole head and hair) inside the visible part of its shape: bloom mask, rounded
// frame, card photo area or full-bleed under overlays. The ladder:
//   (a) box-aware reframe (design/frame.ts), (b) for a bloom-masked photo whose mask shows < MIN_COVERAGE, score every
//   chunky photo mask that fits the same box (maskFits) and switch to the best, (c) the head itself still cut ->
//   needsRegenerate (regenerate at photoTargetAspect / photoVisibleRect).
// Layers without a subjectBox behave exactly as before (plain reframe, coverage 1).
import { PHOTO_MASKS } from '../brand';
import type { BloomShape, Design, Layer, PhotoLayer } from '../types';
import { headCoverage, reframePhoto, subjectCoverage, visibleRect } from './frame';
import { BLOOM_ASPECT, BLOOM_CORE } from './shapes';
import { overlaps, samplePoints, surfaceAt } from './util';

/** Copy, logo, buttons and stats: a swapped mask must not newly cover them. */
const CONTENT = new Set<Layer['kind']>(['text', 'button', 'logo', 'tags', 'stat']);

/** May the photo switch to `mask` in its CURRENT box? The box was sized and placed for the template's mask, so only
 *  when the bloom keeps its natural aspect (within 5%: blooms are never squashed), covers no copy/logo/button/stat the
 *  current mask leaves clear, and does not repeat a bloom drawn behind the photo (depth bloom). */
function maskFits(design: Design, layer: PhotoLayer, mask: BloomShape): boolean {
  const a = BLOOM_ASPECT[mask];
  if (!a || !(layer.width > 0) || !(layer.height > 0) || Math.abs(layer.width / layer.height / a - 1) > 0.05) return false;
  const idx = design.layers.findIndex((l) => l.id === layer.id);
  if (design.layers.slice(0, Math.max(0, idx)).some((l) => l.kind === 'bloom' && !l.hidden && l.shape === mask && overlaps(l, layer))) return false;
  const cand: PhotoLayer = { ...layer, mask };
  return !design.layers.some(
    (l) => CONTENT.has(l.kind) && !l.hidden && samplePoints(l, 5, 3, 0).some(([x, y]) => !!surfaceAt(cand, x, y) && !surfaceAt(layer, x, y)),
  );
}

/** Share of the subject box that must be visible for a placement to pass. */
export const MIN_COVERAGE = 0.95;

/** Largest fully visible rectangle of the photo's shape, as box fractions [x0, y0, x1, y1]: after the bloom mask, the
 *  canvas edge and (with `design`) the layers drawn above it (card, buttons, stat...). y0 = where the visible part starts
 *  (how much headroom the generated image must leave above the subject). Falls back to BLOOM_CORE / the whole box. */
export function photoVisibleRect(layer: PhotoLayer, design?: Design): [number, number, number, number] {
  const r = visibleRect(layer, design);
  if (r) return r;
  return (layer.mask ? BLOOM_CORE[layer.mask] : undefined) ?? [0, 0, 1, 1];
}

/** Usable w/h of the VISIBLE part of the photo's shape (photoVisibleRect in px), not of the whole box: only a fraction
 *  of a bloom box is visible. Generate the image with the subject composed for this shape. Pass the Design to count
 *  layers drawn over the photo. */
export function photoTargetAspect(layer: PhotoLayer, design?: Design): number {
  const w = layer.width > 0 ? layer.width : 1;
  const h = layer.height > 0 ? layer.height : 1;
  const [x0, y0, x1, y1] = photoVisibleRect(layer, design);
  return x1 > x0 && y1 > y0 ? ((x1 - x0) * w) / ((y1 - y0) * h) : w / h;
}

export interface PhotoFit {
  /** Props to apply to the layer (crop, and `mask` when a different bloom fits the subject better). */
  props: Partial<PhotoLayer>;
  /** Fraction (0..1) of the subject box visible with `props` applied (= subjectCoverage). */
  coverage: number;
  /** No crop or mask in this box shows enough of the subject, and the head itself is cut: the image must change. */
  needsRegenerate: boolean;
}

/** Shape-aware placement for one photo layer: (a) box-aware reframe (face first when no crop shows the whole box);
 *  (b) if the current mask shows < MIN_COVERAGE of the subject box, every chunky photo mask that fits the same box
 *  (maskFits) is scored and the best one wins; (c) needsRegenerate when even the best stays < MIN_COVERAGE AND the head
 *  (headCoverage) is cut too: a tall box whose body runs out of the shape but whose head is in view needs no new
 *  image. `coverage` always equals subjectCoverage of the layer with `props` applied. */
export function fitPhotoLayer(design: Design, layerId: string): PhotoFit {
  const layer = design.layers.find((l): l is PhotoLayer => l.id === layerId && l.kind === 'photo');
  if (!layer) return { props: {}, coverage: 1, needsRegenerate: false };
  let props: Partial<PhotoLayer> = reframePhoto(layer, design);
  let coverage = subjectCoverage({ ...layer, ...props }, design);
  if (coverage < MIN_COVERAGE && layer.mask && layer.subjectBox) {
    for (const mask of PHOTO_MASKS) {
      if (mask === layer.mask || !maskFits(design, layer, mask)) continue;
      const cand: PhotoLayer = { ...layer, mask };
      const f = reframePhoto(cand, design);
      const cov = subjectCoverage({ ...cand, ...f }, design);
      if (cov > coverage + 0.005) {
        props = { ...f, mask };
        coverage = cov;
      }
    }
  }
  const head = coverage < MIN_COVERAGE ? headCoverage({ ...layer, ...props }, design) : 1;
  return { props, coverage, needsRegenerate: coverage < MIN_COVERAGE && head < MIN_COVERAGE };
}
