// Shape-aware photo placement (pure). Keeps a photo's essential subject region (layer.subjectBox: what must stay visible
// for the crop to look good, always the whole head and hair) inside the visible part of its shape: bloom mask, rounded
// frame, card photo area or full-bleed under overlays. The ladder:
//   (a) box-aware reframe (design/frame.ts), (b) for a bloom-masked photo whose mask shows < MIN_COVERAGE, score every
//   chunky photo mask in the same box and switch to the best, (c) still under MIN_COVERAGE -> needsRegenerate
//   (regenerate at photoTargetAspect / photoVisibleRect).
// Layers without a subjectBox behave exactly as before (plain reframe, coverage 1).
import { PHOTO_MASKS } from '../brand';
import type { Design, PhotoLayer } from '../types';
import { reframePhoto, subjectCoverage, visibleRect } from './frame';
import { BLOOM_CORE } from './shapes';

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
  /** No crop or mask in this box shows enough of the subject: the image itself must change. */
  needsRegenerate: boolean;
}

/** Shape-aware placement for one photo layer: (a) box-aware reframe; (b) if the current mask shows < MIN_COVERAGE of
 *  the subject box, every chunky photo mask (same box) is scored and the best one wins; (c) needsRegenerate when even
 *  the best stays < MIN_COVERAGE. `coverage` always equals subjectCoverage of the layer with `props` applied. */
export function fitPhotoLayer(design: Design, layerId: string): PhotoFit {
  const layer = design.layers.find((l): l is PhotoLayer => l.id === layerId && l.kind === 'photo');
  if (!layer) return { props: {}, coverage: 1, needsRegenerate: false };
  let props: Partial<PhotoLayer> = reframePhoto(layer, design);
  let coverage = subjectCoverage({ ...layer, ...props }, design);
  if (coverage < MIN_COVERAGE && layer.mask && layer.subjectBox) {
    for (const mask of PHOTO_MASKS) {
      if (mask === layer.mask) continue;
      const cand: PhotoLayer = { ...layer, mask };
      const f = reframePhoto(cand, design);
      const cov = subjectCoverage({ ...cand, ...f }, design);
      if (cov > coverage + 0.005) {
        props = { ...f, mask };
        coverage = cov;
      }
    }
  }
  return { props, coverage, needsRegenerate: coverage < MIN_COVERAGE };
}
