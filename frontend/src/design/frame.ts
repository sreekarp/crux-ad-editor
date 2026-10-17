// Subject-aware photo framing (pure). A photo layer that knows where its subject (main face) is in the source image
// can be re-cropped for any box: after a template switch, a resize, a move, or an explicit "reframe" op.
// The renderer (canvas/photo.ts) cover-fits the photo into the box and offsets it by
//   dx = (boxW - drawnW) * focusX   (object-position semantics), same for y.
// We aim the face at the part of the photo a viewer can actually SEE: inside the canvas, inside the photo's own bloom
// mask, and not covered by layers drawn above it (the white copy card, stat card, buttons, blooms, logo, text).
import type { Design, Layer, PhotoLayer } from '../types';
import { BLOOM_GRID } from './shapes';
import { surfaceAt } from './util';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface Framing {
  focusX: number;
  focusY: number;
  zoom: number;
}

type Box = { x: number; y: number; width: number; height: number; zoom?: number; id?: string; mask?: PhotoLayer['mask'] };
type Canvas = { width: number; height: number; layers?: Layer[] };

/** Layers whose box hides what's under it (text/logo/tags have no "surface" but a face under them still reads badly). */
const BOX_OCCLUDERS = new Set<Layer['kind']>(['text', 'logo', 'tags', 'button', 'stat']);
const GRID = 24;

function gridHit(rows: string[] | undefined, u: number, v: number): boolean {
  if (!rows?.length) return true;
  const r = rows[Math.min(rows.length - 1, Math.floor(v * rows.length))];
  return r[Math.min(r.length - 1, Math.floor(u * r.length))] === '1';
}

const inBox = (l: Layer, px: number, py: number) => px >= l.x && px <= l.x + l.width && py >= l.y && py <= l.y + l.height;

/** Visible layers drawn above the photo; null when the photo isn't in `canvas.layers`. */
function layersAbove(box: Box, canvas: Canvas): Layer[] | null {
  const layers = canvas.layers;
  const idx = box.id && layers ? layers.findIndex((l) => l.id === box.id) : -1;
  if (!layers || idx < 0) return null;
  return layers.slice(idx + 1).filter((l) => !l.hidden);
}

/** Box-local target (px) for the face: a little above the centre of the largest visible region of the photo box,
 *  plus that region's span. null when the photo isn't in `canvas.layers` (then the caller falls back to the box). */
export function visibleTarget(box: Box, canvas: Canvas): { tx: number; ty: number; spanX: number; spanY: number } | null {
  const above = layersAbove(box, canvas);
  if (!above) return null;
  return targetFromGrid(visibilityGrid(box, canvas, above), box);
}

/** n x n cells (GRID by default) over the box (row-major), true where a viewer sees the photo: on the canvas, inside the bloom
 *  mask, and not under any of `above`. Same test the renderer's result is judged by. */
function visibilityGrid(box: Box, canvas: Canvas, above: Layer[], n = GRID): boolean[] {
  const vis = new Array<boolean>(n * n).fill(false);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const v = (j + 0.5) / n;
      const px = box.x + u * box.width;
      const py = box.y + v * box.height;
      let ok = px >= 0 && py >= 0 && px <= canvas.width && py <= canvas.height;
      if (ok && box.mask) ok = gridHit(BLOOM_GRID[box.mask], u, v);
      if (ok) {
        for (const l of above) {
          if (BOX_OCCLUDERS.has(l.kind) ? inBox(l, px, py) : surfaceAt(l, px, py)) {
            ok = false;
            break;
          }
        }
      }
      vis[j * n + i] = ok;
    }
  }
  return vis;
}

/** Cells (row-major indices) of the largest 4-connected visible region of an n x n grid. */
function largestRegion(vis: boolean[], n: number): number[] {
  const seen = new Array<boolean>(n * n).fill(false);
  let best: number[] = [];
  for (let s = 0; s < vis.length; s++) {
    if (!vis[s] || seen[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = true;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const ci = c % n;
      const cj = Math.floor(c / n);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nb = nj * n + ni;
        if (vis[nb] && !seen[nb]) {
          seen[nb] = true;
          stack.push(nb);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

function targetFromGrid(vis: boolean[], box: Box): { tx: number; ty: number; spanX: number; spanY: number } | null {
  // Largest 4-connected visible region.
  const best = largestRegion(vis, GRID);
  if (best.length < 4) return null;
  let minI = GRID, maxI = 0, minJ = GRID, maxJ = 0, sumI = 0;
  for (const c of best) {
    const i = c % GRID;
    const j = Math.floor(c / GRID);
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    minJ = Math.min(minJ, j);
    maxJ = Math.max(maxJ, j);
    sumI += i;
  }
  const cw = box.width / GRID;
  const ch = box.height / GRID;
  // Vertical extent measured around the face's column: bloom masks and cards curve, so the top edge differs per column.
  const meanI = sumI / best.length;
  let colMin = GRID, colMax = -1;
  for (const c of best) {
    if (Math.abs((c % GRID) - meanI) > 2) continue;
    const j = Math.floor(c / GRID);
    colMin = Math.min(colMin, j);
    colMax = Math.max(colMax, j);
  }
  if (colMax >= 0) {
    minJ = colMin;
    maxJ = colMax;
  }
  const top = minJ * ch;
  const bottom = (maxJ + 1) * ch;
  return {
    tx: (meanI + 0.5) * cw,
    ty: top + (bottom - top) * 0.42, // faces read best a little above centre
    spanX: (maxI - minI + 1) * cw,
    spanY: bottom - top,
  };
}

/** Crop that puts `subject` (fractions of the source image) a little above the centre of the visible part of the
 *  box. Pass the Design as `canvas` (and a box with the photo's `id`) to account for layers drawn over the photo.
 *  Zooms in (up to 2.2x) only when the photo can't otherwise be shifted far enough.
 *  With `subjectBox` (whole subject, source fractions) it instead keeps that WHOLE box on visible photo (see frameBox). */
export function frameSubject(
  box: Box,
  canvas: Canvas,
  subject: [number, number],
  src: { w: number; h: number },
  subjectBox?: [number, number, number, number] | null,
): Framing {
  const [sx, sy] = subject;
  const base = Math.max(1, box.zoom || 1);
  const bw = box.width;
  const bh = box.height;
  const vx0 = Math.max(0, -box.x);
  const vx1 = Math.min(bw, canvas.width - box.x);
  const vy0 = Math.max(0, -box.y);
  const vy1 = Math.min(bh, canvas.height - box.y);
  if (!src.w || !src.h || vx1 <= vx0 || vy1 <= vy0) return { focusX: sx, focusY: sy, zoom: base };
  const sb = cleanBox(subjectBox);
  if (sb) {
    const fb = frameBox(box, canvas, subject, src, sb);
    if (fb.full) return fb.framing;
    // No crop shows the whole box (tall bank boxes, low blooms): face first. The point framing wins when it shows
    // clearly more of the head and face; otherwise the box framing (more of the essential region) stays.
    const fp = frameSubject(box, canvas, subject, src);
    const { coverage } = visibleField(box, canvas);
    const [head, face] = headRects(sb, subject, src);
    const seen = (f: Framing) =>
      coverage(placeRect(bw, bh, src, f.zoom, f.focusX, f.focusY, head)) + coverage(placeRect(bw, bh, src, f.zoom, f.focusX, f.focusY, face));
    return seen(fp) > seen(fb.framing) + 0.02 ? fp : fb.framing;
  }
  const vt = visibleTarget(box, canvas);
  const tx = vt ? vt.tx : (vx0 + vx1) / 2;
  const spanX = vt ? vt.spanX : vx1 - vx0;
  const top = vt ? vt.ty - 0.42 * vt.spanY : vy0;
  const spanY = vt ? vt.spanY : vy1 - vy0;
  // Acceptable zones for the face (box-local px): horizontally around the visible region's centre, vertically in its
  // upper part with headroom. A cover-fitted photo can only slide by its overflow, so each axis has a reachable range.
  const want = {
    x: { lo: tx - 0.25 * spanX, pref: tx, hi: tx + 0.25 * spanX },
    y: { lo: top + 0.12 * spanY, pref: top + 0.36 * spanY, hi: top + 0.6 * spanY },
  };
  const axis = (b: number, drawn: number, s: number, w: { lo: number; pref: number; hi: number }) => {
    const over = drawn - b;
    const rMax = s * drawn; // focus 0: photo aligned to the box's top/left edge
    const rMin = over > 1 ? rMax - over : rMax; // focus 1
    const lo = Math.max(w.lo, rMin);
    const hi = Math.min(w.hi, rMax);
    const gap = lo <= hi ? 0 : lo - hi;
    const t = gap ? (w.pref < lo ? Math.min(lo, rMax) : Math.max(hi, rMin)) : Math.min(hi, Math.max(lo, w.pref));
    return { f: over > 1 ? clamp01((rMax - t) / over) : 0.5, gap };
  };
  let best = { fx: 0.5, fy: 0.5, z: 1, gap: Infinity };
  for (let z = 1; z <= 2.2 + 1e-9; z += 0.1) {
    const k = Math.max(bw / src.w, bh / src.h) * z;
    const x = axis(bw, src.w * k, sx, want.x);
    const y = axis(bh, src.h * k, sy, want.y);
    const gap = x.gap + y.gap;
    if (gap === 0) return { focusX: x.f, focusY: y.f, zoom: Math.round(z * 100) / 100 }; // least zoom that works
    if (gap < best.gap - 1e-6) best = { fx: x.f, fy: y.f, z: Math.round(z * 100) / 100, gap };
  }
  return { focusX: best.fx, focusY: best.fy, zoom: best.z };
}

// ---------------------------------------------------------------------------------------------
// Essential-region framing: the subject box (source fractions; what must stay visible for the crop to look good,
// always the whole head and hair) must land on visible photo, not just the face point.

type Rect = [number, number, number, number];

/** Sanitised subject box (ordered, clamped to 0..1, non-degenerate) or null. */
function cleanBox(b: readonly number[] | null | undefined): Rect | null {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(v))) return null;
  const x0 = clamp01(Math.min(b[0], b[2]));
  const x1 = clamp01(Math.max(b[0], b[2]));
  const y0 = clamp01(Math.min(b[1], b[3]));
  const y1 = clamp01(Math.max(b[1], b[3]));
  return x1 - x0 >= 0.01 && y1 - y0 >= 0.01 ? [x0, y0, x1, y1] : null;
}

/** Box-local px rect of the source-fraction rect `r` after the renderer's cover-fit * zoom + focus (canvas/photo.ts). */
function placeRect(bw: number, bh: number, src: { w: number; h: number }, z: number, fx: number, fy: number, r: Rect): Rect {
  const k = Math.max(bw / src.w, bh / src.h) * z;
  const dw = src.w * k;
  const dh = src.h * k;
  const dx = (bw - dw) * fx;
  const dy = (bh - dh) * fy;
  return [dx + r[0] * dw, dy + r[1] * dh, dx + r[2] * dw, dy + r[3] * dh];
}

/** Finer grid for essential-region framing: bloom grids are 16 columns wide, so 48 cells resolve their edges column by
 *  column (the point path keeps GRID). */
const FINE = 48;

/** Visible cells of the photo box on the FINE grid, plus `coverage(r)`: the visible share (0..1) of a box-local px rect,
 *  exact for the grid in O(1) via a summed-area table. Parts of a rect outside the box are never visible. */
function visibleField(box: Box, canvas: Canvas): { vis: boolean[]; coverage: (r: Rect) => number } {
  const n = FINE;
  const m = n + 1;
  const vis = visibilityGrid(box, canvas, layersAbove(box, canvas) ?? [], n);
  const S = new Float64Array(m * m);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) S[(j + 1) * m + i + 1] = (vis[j * n + i] ? 1 : 0) + S[j * m + i + 1] + S[(j + 1) * m + i] - S[j * m + i];
  // Visible cells in [0, x] x [0, y] (cell units). Bilinear between table entries is exact: the integral of a
  // piecewise-constant grid is bilinear inside each cell.
  const cum = (x: number, y: number) => {
    const cx = Math.min(n, Math.max(0, x));
    const cy = Math.min(n, Math.max(0, y));
    const i = Math.min(n - 1, Math.floor(cx));
    const j = Math.min(n - 1, Math.floor(cy));
    const fx = cx - i;
    const fy = cy - j;
    return S[j * m + i] * (1 - fx) * (1 - fy) + S[j * m + i + 1] * fx * (1 - fy) + S[(j + 1) * m + i] * (1 - fx) * fy + S[(j + 1) * m + i + 1] * fx * fy;
  };
  const kx = n / box.width;
  const ky = n / box.height;
  const coverage = (r: Rect): number => {
    const [x0, y0, x1, y1] = [r[0] * kx, r[1] * ky, r[2] * kx, r[3] * ky];
    const area = (x1 - x0) * (y1 - y0);
    if (!(area > 0)) return 1;
    return Math.min(1, Math.max(0, (cum(x1, y1) - cum(x0, y1) - cum(x1, y0) + cum(x0, y0)) / area));
  };
  return { vis, coverage };
}

/** Largest fully visible rectangle of the photo box, as box fractions [x0, y0, x1, y1]: the usable part of its shape
 *  after the bloom mask, the canvas edge and layers drawn above (pass the Design; without one only the mask counts).
 *  y0 says how far down the visible part starts (headroom). null when nothing is visible. */
export function visibleRect(box: Box, canvas?: Canvas): Rect | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const n = FINE;
  const { vis } = visibleField(box, canvas ?? { width: Infinity, height: Infinity });
  const h = new Array<number>(n).fill(0);
  let bestArea = 0;
  let best: Rect | null = null;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) h[i] = vis[j * n + i] ? h[i] + 1 : 0;
    for (let i = 0; i < n; i++) {
      let minH = Infinity;
      for (let k = i; k < n && h[k] > 0; k++) {
        minH = Math.min(minH, h[k]);
        const area = minH * (k - i + 1);
        if (area > bestArea) {
          bestArea = area;
          best = [i / n, (j + 1 - minH) / n, (k + 1) / n, (j + 1) / n];
        }
      }
    }
  }
  return best;
}

const FULL = 0.995;

/** Least zoom in [1, 2.2] (and focus) that puts the WHOLE essential region (subject box) on visible photo, preferring
 *  a little breathing room around it, centred in the largest visible region and the face (`subject`) in the upper part
 *  of the visible span measured in the subject's OWN columns (bloom edges and cards curve, so the edge above the head is
 *  not the edge at the region's centre). Zoom only slides the photo further; it never blows a close-up box up to fill
 *  the shape. When no crop shows the whole box: the crop showing the largest fraction, keeping the head over the lower
 *  body (the renderer can't zoom out below cover-fit; fitPhotoLayer then tries another mask or asks for a regenerate). */
function frameBox(box: Box, canvas: Canvas, subject: [number, number], src: { w: number; h: number }, sb: Rect): { framing: Framing; full: boolean } {
  const bw = box.width;
  const bh = box.height;
  const n = FINE;
  const { vis, coverage } = visibleField(box, canvas);
  const cw = bw / n;
  const ch = bh / n;
  // Largest visible region: its centre column/width, and its visible top/bottom per column.
  const region = largestRegion(vis, n);
  const colTop = new Array<number>(n).fill(Infinity);
  const colBot = new Array<number>(n).fill(-Infinity);
  let minI = n, maxI = -1, sumI = 0;
  for (const c of region) {
    const i = c % n;
    const j = (c - i) / n;
    colTop[i] = Math.min(colTop[i], j * ch);
    colBot[i] = Math.max(colBot[i], (j + 1) * ch);
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    sumI += i;
  }
  const tcx = region.length ? (sumI / region.length + 0.5) * cw : bw / 2;
  const spanX = region.length ? (maxI - minI + 1) * cw : bw;
  /** Visible [top, bottom] (box px) across the columns the placed subject spans: the lowest top and highest bottom. */
  const band = (x0: number, x1: number): [number, number] => {
    let t = -Infinity;
    let b = Infinity;
    for (let i = Math.max(0, Math.floor(x0 / cw)); i <= Math.min(n - 1, Math.ceil(x1 / cw) - 1); i++) {
      if (colTop[i] === Infinity) continue;
      t = Math.max(t, colTop[i]);
      b = Math.min(b, colBot[i]);
    }
    return b - t > ch ? [t, b] : [0, bh];
  };
  const faceY = Math.min(sb[3], Math.max(sb[1], clamp01(subject[1])));
  // Head band (top of the box down to as far below the face as the hair is above it): what must survive a forced cut.
  const head: Rect = [sb[0], sb[1], sb[2], Math.min(sb[3], Math.max(faceY + (faceY - sb[1]), sb[1] + 0.2 * (sb[3] - sb[1])))];
  const steps = (over: number) => (over > 1 ? Array.from({ length: 21 }, (_, s) => s / 20) : [0.5]);
  let best = { fx: 0.5, fy: 0.5, z: 1, score: -Infinity };
  for (let s = 0; s <= 12; s++) {
    const z = 1 + s / 10;
    const k = Math.max(bw / src.w, bh / src.h) * z;
    let zBest = { fx: 0.5, fy: 0.5, score: -Infinity };
    let zFull = { fx: 0.5, fy: 0.5, score: -Infinity };
    for (const fx of steps(src.w * k - bw)) {
      for (const fy of steps(src.h * k - bh)) {
        const r = placeRect(bw, bh, src, z, fx, fy, sb);
        const cov = coverage(r);
        const full = cov >= FULL;
        if (!full && zFull.score > -Infinity) continue; // a whole-box crop already exists at this zoom
        if (cov * 1000 + 200 < zBest.score - 50) continue; // can't win: skip the finer terms
        const w = r[2] - r[0];
        const h = r[3] - r[1];
        const pad = coverage([r[0] - 0.08 * w, r[1] - 0.08 * h, r[2] + 0.08 * w, r[3] + 0.08 * h]);
        const headCov = full ? 1 : coverage(placeRect(bw, bh, src, z, fx, fy, head));
        const [top, bottom] = band(r[0], r[2]);
        const spanY = bottom - top;
        const fyPx = r[1] + ((faceY - sb[1]) / (sb[3] - sb[1])) * h;
        const cost =
          Math.abs((r[0] + r[2]) / 2 - tcx) / spanX +
          Math.abs((r[1] + r[3]) / 2 - (top + bottom) / 2) / spanY +
          2 * Math.max(0, (fyPx - (top + 0.55 * spanY)) / spanY); // face in the upper part of its column
        const score = 1000 * cov + 200 * headCov + 20 * pad - cost - 20 * (z - 1);
        if (full && score > zFull.score) zFull = { fx, fy, score };
        if (score > zBest.score) zBest = { fx, fy, score };
      }
    }
    // Least zoom at which the whole box fits; within it, the best margins and placement.
    if (zFull.score > -Infinity) return { framing: { focusX: zFull.fx, focusY: zFull.fy, zoom: Math.round(z * 100) / 100 }, full: true };
    if (zBest.score > best.score) best = { fx: zBest.fx, fy: zBest.fy, z: Math.round(z * 100) / 100, score: zBest.score };
  }
  return { framing: { focusX: best.fx, focusY: best.fy, zoom: best.z }, full: false };
}

/** Head (source fractions: box top = hair, down to as far below the face as the hair is above it, as wide as tall in
 *  source px, centred on the face) and the face patch inside it: what a forced cut must keep first. */
function headRects(sb: Rect, subject: [number, number], src: { w: number; h: number }): [Rect, Rect] {
  const faceY = Math.min(sb[3], Math.max(sb[1], clamp01(subject[1])));
  const faceX = Math.min(sb[2], Math.max(sb[0], clamp01(subject[0])));
  const y1 = Math.min(sb[3], Math.max(faceY + (faceY - sb[1]), sb[1] + 0.2 * (sb[3] - sb[1])));
  const hh = y1 - sb[1];
  const hw = (hh * src.h) / src.w; // same px size across
  const head: Rect = [Math.max(sb[0], faceX - hw / 2), sb[1], Math.min(sb[2], faceX + hw / 2), y1];
  const face: Rect = [faceX - hw / 4, Math.max(sb[1], faceY - hh / 4), faceX + hw / 4, Math.min(y1, faceY + hh / 4)];
  return [head, face];
}

/** Fraction (0..1) of the layer's head (headRects: hair to chin, as wide as tall) visible with its CURRENT crop; 1
 *  without a subject box or source size. A forced cut that keeps this keeps what matters most. */
export function headCoverage(layer: PhotoLayer, design: Design): number {
  const sb = cleanBox(layer.subjectBox);
  if (!sb || !layer.srcW || !layer.srcH || !(layer.width > 0) || !(layer.height > 0)) return 1;
  const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const src = { w: layer.srcW, h: layer.srcH };
  const subject: [number, number] = layer.subject ?? [(sb[0] + sb[2]) / 2, sb[1] + 0.15 * (sb[3] - sb[1])];
  const z = Math.max(1, fin(layer.zoom, 1));
  const r = placeRect(layer.width, layer.height, src, z, clamp01(fin(layer.focusX, 0.5)), clamp01(fin(layer.focusY, 0.5)), headRects(sb, subject, src)[0]);
  return visibleField(layer, design).coverage(r);
}

/** Fraction (0..1) of the layer's subject box that a viewer sees with its CURRENT crop (canvas, bloom mask and layers
 *  drawn above all count, as drawn by canvas/photo.ts). 1 when the layer has no subject box or source size. */
export function subjectCoverage(layer: PhotoLayer, design: Design): number {
  const sb = cleanBox(layer.subjectBox);
  if (!sb || !layer.srcW || !layer.srcH || !(layer.width > 0) || !(layer.height > 0)) return 1;
  const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const z = Math.max(1, fin(layer.zoom, 1));
  const r = placeRect(layer.width, layer.height, { w: layer.srcW, h: layer.srcH }, z, clamp01(fin(layer.focusX, 0.5)), clamp01(fin(layer.focusY, 0.5)), sb);
  return visibleField(layer, design).coverage(r);
}

/** Framing for a photo layer that knows its subject (face point and/or whole-subject box); {} when it doesn't (then
 *  nothing changes). Pass the Design so layers drawn above the photo are taken into account. */
export function reframePhoto(layer: PhotoLayer, canvas: Canvas): Partial<Framing> {
  const sb = cleanBox(layer.subjectBox);
  if ((!layer.subject && !sb) || !layer.srcW || !layer.srcH) return {};
  const subject: [number, number] = layer.subject ?? [(sb![0] + sb![2]) / 2, sb![1] + 0.15 * (sb![3] - sb![1])];
  return frameSubject({ ...layer, zoom: 1 }, canvas, subject, { w: layer.srcW, h: layer.srcH }, sb);
}
