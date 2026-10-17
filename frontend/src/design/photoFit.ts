// Shape-aware photo placement (pure). Keeps a photo's essential subject region (layer.subjectBox: what must stay visible
// for the crop to look good, always the whole head and hair) inside the visible part of its shape: bloom mask, rounded
// frame, card photo area or full-bleed under overlays. The ladder:
//   (a) box-aware reframe (design/frame.ts), (b) for a bloom-masked photo whose mask shows < MIN_COVERAGE, score every
//   chunky photo mask that fits the same box (maskFits) and switch to the best, (c) the head itself still cut ->
//   needsRegenerate (regenerate at photoTargetAspect / photoVisibleRect).
// Layers without a subjectBox behave exactly as before (plain reframe, coverage 1).
import { PHOTO_MASKS, SAFE } from '../brand';
import type { BloomShape, Design, Layer, PhotoLayer } from '../types';
import { headCoverage, headRectOnCanvas, reframePhoto, subjectCoverage, visibleRect } from './frame';
import { BLOOM_ASPECT, BLOOM_CORE } from './shapes';
import { bounds, overlaps, r1, samplePoints, surfaceAt } from './util';

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

// ---------------------------------------------------------------------------------------------
// Decor off faces. Charms are kept off copy at build time, but the photo's crop is only known after framing, so a charm
// (or stat card) can land on the subject's head. Layout paths (rebuild, resize, reframe, photo swap, build + focus)
// run keepDecorOffFaces after framing; a plain user drag/update never does, so hand-placed decor stays put.

type Ext = { x0: number; y0: number; x1: number; y1: number };

/** A charm / stat card may cover at most this share of its own area with a head before it is moved. */
export const HEAD_OVERLAP_MAX = 0.08;
/** What moved decor must not land on: the message, plus other charms and stat cards (no piling up). */
const DECOR_BLOCKERS = new Set<Layer['kind']>(['text', 'logo', 'button', 'tags', 'stat', 'charm']);

const isDecorMover = (l: Layer) => !l.hidden && ((l.kind === 'charm' && l.role !== 'decor') || l.kind === 'stat');
const hitsExt = (a: Ext, b: Ext) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const interArea = (a: Ext, b: Ext) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const insetExt = (r: Ext, f: number): Ext => {
  const dx = (r.x1 - r.x0) * f;
  const dy = (r.y1 - r.y0) * f;
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 - dx, y1: r.y1 - dy };
};

/** Head boxes (canvas px, clipped to the canvas) of the visible photos whose subject is known. */
function headExts(design: Design): { r: Ext; photo: PhotoLayer }[] {
  const out: { r: Ext; photo: PhotoLayer }[] = [];
  for (const l of design.layers) {
    if (l.kind !== 'photo' || l.hidden) continue;
    const h = headRectOnCanvas(l);
    if (!h) continue;
    const r = { x0: Math.max(0, h.x), y0: Math.max(0, h.y), x1: Math.min(design.width, h.x + h.width), y1: Math.min(design.height, h.y + h.height) };
    if (r.x1 - r.x0 > 0.5 && r.y1 - r.y0 > 0.5) out.push({ r, photo: l });
  }
  return out;
}

/** One pass: every charm / stat card covering a head by > HEAD_OVERLAP_MAX of its area moves (same size and rotation)
 *  to the cheapest free spot on a coarse grid: inside the safe margin, clear of every head, copy, logo, button, tags and
 *  other decor; cost = distance, plus a penalty when the spot leaves the photo / bloom edge (decor straddles the photo's
 *  silhouette in the refs). Left where it is when nothing fits. null when nothing moved. */
function decorPass(design: Design, heads: { r: Ext; photo: PhotoLayer }[]): Design | null {
  const W = design.width;
  const H = design.height;
  const m = W * SAFE.margin;
  const margin: Ext = { x0: m, y0: m, x1: W - m, y1: H - m };
  // 9:16: a stat card is content, so it stays in the story safe zone (charms only keep the margin).
  const story: Ext = { x0: W * SAFE.story.side, y0: H * SAFE.story.top, x1: W * (1 - SAFE.story.side), y1: H * (1 - SAFE.story.bottom) };
  const step = Math.max(2, Math.min(W, H) * 0.02);
  const edgePenalty = Math.min(W, H) * 0.25;
  let layers: Layer[] | null = null;
  const cur = () => layers ?? design.layers;
  for (let i = 0; i < design.layers.length; i++) {
    const l = cur()[i];
    if (!isDecorMover(l)) continue;
    const b = bounds(l);
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (!(area > 0)) continue;
    const hit = heads.find((h) => interArea(b, h.r) > HEAD_OVERLAP_MAX * area);
    if (!hit) continue;
    const pad = l.kind === 'charm' ? 0.1 : 0; // charm art has transparent padding; a stat card is solid to its edge
    const blockers = cur()
      .filter((o, j) => j !== i && !o.hidden && DECOR_BLOCKERS.has(o.kind))
      .map((o) => bounds(o));
    // The silhouette edges the decor should stay on: the photo whose head it covered, and blooms around that photo.
    const pb = bounds(hit.photo);
    const anchors: Layer[] = [hit.photo, ...cur().filter((o) => o.kind === 'bloom' && !o.hidden && hitsExt(bounds(o), pb))];
    // On the edge = straddling the visible silhouette (photo + those blooms): part on it, part off it.
    const onEdge = (e: Ext) => {
      const pts = samplePoints({ x: e.x0, y: e.y0, width: e.x1 - e.x0, height: e.y1 - e.y0 }, 4, 4, 0.15);
      const n = pts.filter(([x, y]) => anchors.some((a) => !!surfaceAt(a, x, y))).length;
      return n > 0 && n < pts.length;
    };
    const f = l.kind === 'stat' && H / W > 1.6 ? story : margin;
    let best: { x: number; y: number; cost: number } | null = null;
    const i0 = Math.ceil((f.x0 - b.x0) / step);
    const i1 = Math.floor((f.x1 - b.x1) / step);
    const j0 = Math.ceil((f.y0 - b.y0) / step);
    const j1 = Math.floor((f.y1 - b.y1) / step);
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        const nx = r1(l.x + ii * step);
        const ny = r1(l.y + jj * step);
        const dx = nx - l.x;
        const dy = ny - l.y;
        const dist = Math.hypot(dx, dy);
        if (best && dist >= best.cost) continue; // can't beat the best (cost >= distance)
        const e = { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
        if (e.x0 < f.x0 - 0.5 || e.y0 < f.y0 - 0.5 || e.x1 > f.x1 + 0.5 || e.y1 > f.y1 + 0.5) continue;
        if (heads.some((h) => hitsExt(e, h.r))) continue;
        const core = insetExt(e, pad);
        if (blockers.some((o) => hitsExt(core, o))) continue;
        const cost = dist + (onEdge(e) ? 0 : edgePenalty);
        if (!best || cost < best.cost) best = { x: nx, y: ny, cost };
      }
    }
    if (!best) continue;
    layers ??= design.layers.slice();
    layers[i] = { ...l, x: best.x, y: best.y } as Layer;
  }
  return layers ? { ...design, layers } : null;
}

/** Keep charms and stat cards off the heads of photo subjects (headRectOnCanvas, with each photo's current crop): see
 *  decorPass. Pure, deterministic and idempotent (passes repeat until nothing moves, so running it again changes
 *  nothing); returns the same object when nothing moves. Call it from layout paths only (build/rebuild/resize/fit),
 *  never on a plain user drag or update. */
export function keepDecorOffFaces(design: Design): Design {
  const heads = headExts(design);
  if (!heads.length || !design.layers.some(isDecorMover)) return design;
  let d = design;
  for (let pass = 0; pass < 3; pass++) {
    const next = decorPass(d, heads);
    if (!next) break;
    d = next;
  }
  return d;
}
