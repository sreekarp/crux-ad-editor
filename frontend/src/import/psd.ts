// Photoshop PSD -> editable Design (ag-psd, loaded on demand).
//   type layers                     -> TextLayer (brand fonts, navy/white)
//   short type layer on a solid box -> ButtonLayer (role 'cta')
//   pixel / smart-object / shape    -> ImageLayer (layer masks + clipping masks applied)
//   adjustment layers               -> ignored (noted); hidden layers/groups skipped; group opacity multiplied
// ag-psd: psd.children[0] is the BOTTOM layer (reader unshifts while walking the file top-down), opacity is 0..1.
import type { Color, Layer as PsdLayer, LayerTextData, ParagraphStyle, Psd, TextStyle } from 'ag-psd';
import type { ButtonLayer, Design, ImageLayer, Layer } from '../types';
import type { ImportResult } from './index';
import {
  ALL_TOKENS,
  backgroundOf,
  baseName,
  buildTextLayer,
  clamp,
  ctx2d,
  DESIGN_W,
  ensureBrandFonts,
  errorText,
  fontNote,
  idMaker,
  ImportError,
  isBlank,
  isBrandTextColour,
  isUniform,
  makeCanvas,
  nearestToken,
  PixelSampler,
  plural,
  pool,
  r1,
  r2,
  scaleCanvas,
  snapTextColour,
  UPLOAD_CONCURRENCY,
  uploadCanvas,
  weightFromName,
  yieldToBrowser,
  type RGB,
  type TextSpec,
  type Uploaded,
} from './util';

type AgPsd = typeof import('ag-psd');

const MAX_LEAVES = 80;
const MAX_DOC_SIDE = 30000;
const MAX_DOC_PIXELS = 300e6;

// ---------------------------------------------------------------------------------------------
// Colour / text style helpers

const unit = (v: number) => (v > 1 ? v / 255 : v);

export function colorToRgb(c: Color | undefined | null): RGB | null {
  if (!c) return null;
  if ('r' in c) return [c.r, c.g, c.b];
  if ('fr' in c) return [c.fr * 255, c.fg * 255, c.fb * 255];
  if ('c' in c) {
    const k = unit(c.k);
    return [255 * (1 - unit(c.c)) * (1 - k), 255 * (1 - unit(c.m)) * (1 - k), 255 * (1 - unit(c.y)) * (1 - k)];
  }
  if ('l' in c) {
    const v = clamp(c.l * 2.55, 0, 255);
    return [v, v, v];
  }
  if ('h' in c) {
    const s = c.s > 1 ? c.s / 100 : c.s;
    const v = c.b > 1 ? c.b / 100 : c.b;
    const f = (n: number) => {
      const k = (n + c.h / 60) % 6;
      return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
    };
    return [f(5), f(3), f(1)];
  }
  if ('k' in c) {
    const v = c.k > 1 ? c.k : c.k * 255;
    return [v, v, v];
  }
  return null;
}

function dominantStyle(t: LayerTextData): TextStyle {
  const runs = t.styleRuns ?? [];
  if (!runs.length) return t.style ?? {};
  const best = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return { ...(t.style ?? {}), ...best.style };
}

function dominantParagraph(t: LayerTextData): ParagraphStyle {
  const runs = t.paragraphStyleRuns ?? [];
  if (!runs.length) return t.paragraphStyle ?? {};
  const best = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return { ...(t.paragraphStyle ?? {}), ...best.style };
}

function alignOf(j: ParagraphStyle['justification']): 'left' | 'center' | 'right' {
  if (j === 'center' || j === 'justify-center') return 'center';
  if (j === 'right' || j === 'justify-right') return 'right';
  return 'left';
}

type TextRead = { spec: TextSpec; estimated: boolean } | { rasterize: string } | null;

/** Type layer -> TextSpec in design px. Bounds/transform are document px; (ox, oy) = imported frame origin, S = design scale. */
function readPsdText(l: PsdLayer, S: number, ox: number, oy: number): TextRead {
  const t = l.text;
  if (!t) return null;
  const text = (t.text ?? '')
    .replace(/\r\n?|\u0003/g, '\n')
    .split('\n')
    .map((s) => s.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  if (!text.trim()) return null;
  if (t.orientation === 'vertical') return { rasterize: 'vertical' };
  if (t.warp?.style && t.warp.style !== 'none') return { rasterize: 'warped' };
  const tr = t.transform && t.transform.length >= 6 ? t.transform : [1, 0, 0, 1, l.left ?? 0, l.bottom ?? 0];
  const [xx, xy, yx, yy, tx, ty] = tr;
  if (Math.abs((Math.atan2(xy, xx) * 180) / Math.PI) > 0.5) return { rasterize: 'rotated' };
  const st = dominantStyle(t);
  const ps = dominantParagraph(t);
  const tScale = Math.sqrt(Math.abs(xx * yy - xy * yx)) || 1;
  let fontDoc = (st.fontSize ?? 24) * tScale;
  const n = text.split('\n').length;
  const lh = !st.autoLeading && st.leading ? (st.leading * tScale) / fontDoc : undefined;
  const fontName = st.font?.name ?? 'Unknown';
  const spec: TextSpec = {
    name: l.name || text.split('\n')[0].slice(0, 40),
    text,
    sourceFont: fontName,
    weight: weightFromName(fontName) ?? (st.fauxBold ? 700 : undefined),
    fontPx: 0,
    lineHeight: lh,
    align: alignOf(ps.justification),
    fill: colorToRgb(st.fillColor),
    left: 0,
    right: 0,
  };
  let estimated = false;
  const hasPx = (l.right ?? 0) > (l.left ?? 0) && (l.bottom ?? 0) > (l.top ?? 0);
  if (t.shapeType === 'box' && t.boxBounds && t.boxBounds.length >= 4) {
    const [bl, bt, br] = t.boxBounds;
    spec.paragraph = true;
    spec.left = (tx + bl * xx - ox) * S;
    spec.right = (tx + br * xx - ox) * S;
    spec.top = (ty + bt * yy - oy) * S;
    spec.topMode = 'box';
  } else {
    let baseline: number | undefined = ty;
    if (hasPx) {
      const top = l.top ?? 0;
      const bottom = l.bottom ?? 0;
      const inkH = bottom - top;
      const ratio = inkH / (fontDoc * (0.72 + (n - 1) * (lh ?? 1.2)));
      if (ratio < 0.45 || ratio > 2.2) {
        // Font size units don't match the rendered pixels (e.g. resolution scaling): trust the pixels.
        fontDoc = inkH / (0.9 + (n - 1) * (lh ?? 1.2));
        baseline = undefined;
        estimated = true;
      } else if (ty < top - 0.5 * fontDoc || ty > bottom + 0.5 * fontDoc) {
        baseline = undefined;
      }
      spec.left = ((l.left ?? 0) - ox) * S;
      spec.right = ((l.right ?? 0) - ox) * S;
      spec.top = (top - oy) * S;
      spec.topMode = 'ink';
    } else {
      spec.left = (tx - ox) * S; // alignment anchor; the builder grows the box around it
      spec.right = (tx - ox) * S;
    }
    if (baseline !== undefined) spec.baseline = (baseline - oy) * S;
  }
  spec.fontPx = fontDoc * S;
  spec.letterSpacing = ((st.tracking ?? 0) / 1000) * spec.fontPx;
  return { spec, estimated };
}

// ---------------------------------------------------------------------------------------------
// Pixels

interface Placed {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
}

function layerCanvas(ag: AgPsd, l: PsdLayer): HTMLCanvasElement | undefined {
  if (l.canvas) return l.canvas;
  try {
    return ag.getLayerCanvas(l);
  } catch {
    return undefined;
  }
}

/** Multiplies alpha by the layer's pixel mask (grey value in R; defaultColor outside the mask rect). */
function applyMask(ag: AgPsd, l: PsdLayer, p: Placed): Placed {
  const m = l.mask;
  if (!m || m.disabled) return p;
  let md: { data: ArrayLike<number> } | undefined;
  try {
    md = m.imageData ?? ag.getLayerMaskImageData(l);
  } catch {
    md = undefined;
  }
  const def = (m.defaultColor ?? 255) / 255;
  if (!md && def >= 1) return p;
  const mw = Math.max(0, (m.right ?? 0) - (m.left ?? 0));
  const mh = Math.max(0, (m.bottom ?? 0) - (m.top ?? 0));
  const max = md && md.data instanceof Uint16Array ? 65535 : md && md.data instanceof Float32Array ? 1 : 255;
  const out = makeCanvas(p.canvas.width, p.canvas.height);
  const g = ctx2d(out, true);
  g.drawImage(p.canvas, 0, 0);
  const img = g.getImageData(0, 0, out.width, out.height);
  const px = img.data;
  const ox = p.left - (m.left ?? 0);
  const oy = p.top - (m.top ?? 0);
  for (let y = 0; y < out.height; y++) {
    const gy = y + oy;
    for (let x = 0; x < out.width; x++) {
      const gx = x + ox;
      const v = md && gx >= 0 && gy >= 0 && gx < mw && gy < mh ? md.data[(gy * mw + gx) * 4] / max : def;
      if (v < 1) px[(y * out.width + x) * 4 + 3] *= v;
    }
  }
  g.putImageData(img, 0, 0);
  return { ...p, canvas: out };
}

/** Clipping mask: keep only where the base layer has pixels. */
function clipTo(p: Placed, base: Placed): Placed {
  const out = makeCanvas(p.canvas.width, p.canvas.height);
  const g = ctx2d(out);
  g.drawImage(p.canvas, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(base.canvas, base.left - p.left, base.top - p.top);
  return { ...p, canvas: out };
}

/** Solid-colour fill layer stored without pixels -> full-document canvas. */
function solidFill(ag: AgPsd, l: PsdLayer, psd: Psd): Placed | undefined {
  if (l.vectorFill?.type !== 'color' || l.vectorMask) return undefined;
  const rgb = colorToRgb(l.vectorFill.color);
  if (!rgb) return undefined;
  const big = psd.width * psd.height > 16e6;
  const c = makeCanvas(big ? DESIGN_W : psd.width, big ? (psd.height * DESIGN_W) / psd.width : psd.height);
  const g = ctx2d(c);
  g.fillStyle = `rgb(${rgb.map(Math.round).join(',')})`;
  g.fillRect(0, 0, c.width, c.height);
  const p = { canvas: c, left: 0, top: 0 };
  if (big) return { ...p, canvas: scaleCanvas(c, psd.width, psd.height) };
  return applyMask(ag, l, p);
}

/** Share of opaque pixels in the dominant colour + corner radius estimate (for CTA buttons). */
function solidStats(c: HTMLCanvasElement): { colour: RGB; solid: number; coverage: number; radius: number } | null {
  const s = scaleCanvas(c, Math.min(96, c.width), Math.max(1, Math.round((Math.min(96, c.width) * c.height) / c.width)));
  const d = ctx2d(s, true).getImageData(0, 0, s.width, s.height).data;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    opaque++;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += d[i];
    e.g += d[i + 1];
    e.b += d[i + 2];
    buckets.set(key, e);
  }
  if (!opaque) return null;
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of buckets.values()) if (e.n > best.n) best = e;
  // Corner radius: first opaque pixel on the top-left diagonal sits at r * (1 - 1/sqrt2).
  const full = ctx2d(c, true);
  const n = Math.min(c.width, c.height, 400);
  const diag = full.getImageData(0, 0, n, n).data;
  let i0 = 0;
  while (i0 < n && diag[(i0 * n + i0) * 4 + 3] < 128) i0++;
  return {
    colour: [best.r / best.n, best.g / best.n, best.b / best.n],
    solid: best.n / opaque,
    coverage: opaque / (s.width * s.height),
    radius: i0 / (1 - Math.SQRT1_2),
  };
}

// ---------------------------------------------------------------------------------------------

type Item =
  | {
      type: 'image';
      name: string;
      canvas: HTMLCanvasElement;
      x: number;
      y: number;
      w: number;
      h: number;
      opacity: number;
      /** Document-resolution pixels, kept for button detection only. */
      full?: HTMLCanvasElement;
    }
  | {
      type: 'text';
      spec: TextSpec;
      opacity: number;
      raster?: { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number };
    };

function drawItems(items: Item[], W: number, H: number, withText: boolean): HTMLCanvasElement {
  const c = makeCanvas(W, H);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  for (const it of items) {
    if (it.type === 'image') {
      g.globalAlpha = it.opacity;
      g.drawImage(it.canvas, it.x, it.y, it.w, it.h);
    } else if (withText && it.raster) {
      g.globalAlpha = it.opacity;
      g.drawImage(it.raster.canvas, it.raster.x, it.raster.y, it.raster.w, it.raster.h);
    }
  }
  g.globalAlpha = 1;
  return c;
}

function psdErrorMessage(name: string, e: unknown): string {
  const m = errorText(e);
  if (/color ?mode/i.test(m)) {
    return `${name} uses a colour mode the importer can't read (${m}). In Photoshop choose Image > Mode > RGB Color, save, and try again.`;
  }
  if (/bits ?per ?channel|bit depth/i.test(m)) return `${name} uses an unsupported bit depth (${m}). Try Image > Mode > 8 Bits/Channel.`;
  if (/memory|allocation|Invalid array length/i.test(m)) return `${name} is too large to decode in the browser. Save a smaller copy and try again.`;
  return `${name} couldn't be read — the file may be corrupt or use an unsupported Photoshop feature (${m}). Re-saving with "Maximize compatibility" usually helps.`;
}

async function flatResult(file: File, comp: HTMLCanvasElement, W: number, H: number, why: string): Promise<ImportResult> {
  const flat = scaleCanvas(comp, W, H);
  const up = await uploadCanvas(flat, `${baseName(file.name)}-flat`);
  const layer: ImageLayer = {
    id: 'image-1',
    kind: 'image',
    role: 'flat-image',
    name: file.name,
    src: up.url,
    x: 0,
    y: 0,
    width: W,
    height: H,
    locked: true,
  };
  const design: Design = {
    id: `import-${Date.now().toString(36)}`,
    name: baseName(file.name),
    width: W,
    height: H,
    background: backgroundOf(flat),
    layers: [layer],
  };
  return { kind: 'psd', design, previewUrl: up.url, notes: [`Imported ${file.name} as a flat image: ${why}`, 'Pixel edits work via chat.'] };
}

export async function importPsd(file: File): Promise<ImportResult> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (head.length < 4 || String.fromCharCode(...head) !== '8BPS') {
    throw new ImportError(`${file.name} doesn't look like a Photoshop file (no PSD header) — it may be corrupt or just renamed.`);
  }
  let ag: AgPsd;
  try {
    ag = await import('ag-psd');
  } catch {
    throw new ImportError('The PSD reader failed to load — reload the page and try again.');
  }
  await yieldToBrowser();
  let psd: Psd;
  try {
    // Structure first; bitmaps are decoded per visible layer below (hidden layers never cost memory).
    psd = ag.readPsd(buf, { skipThumbnail: true, useRawData: true });
  } catch (e) {
    throw new ImportError(psdErrorMessage(file.name, e));
  }
  if (!psd.width || !psd.height) throw new ImportError(`${file.name} has no canvas size — the file looks corrupt.`);
  if (psd.width > MAX_DOC_SIDE || psd.height > MAX_DOC_SIDE || psd.width * psd.height > MAX_DOC_PIXELS) {
    throw new ImportError(`${file.name} is ${psd.width}x${psd.height}px — too large to import in the browser. Save a smaller copy (e.g. 2160px wide).`);
  }
  const W = DESIGN_W;
  // Artboards (ad sets often keep every size in one PSD): import one -- closest to the editor's 4:5,
  // ties -> top-most -- and crop to it.
  const boards = (psd.children ?? []).filter((l) => l.artboard?.rect && l.children && !l.hidden);
  let frame = { left: 0, top: 0, width: psd.width, height: psd.height };
  let roots: PsdLayer[] = psd.children ?? [];
  let boardNote = '';
  if (boards.length) {
    const rectOf = (l: PsdLayer) => {
      const r = l.artboard!.rect;
      return { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top };
    };
    const score = (l: PsdLayer) => {
      const r = rectOf(l);
      return r.width > 0 && r.height > 0 ? Math.abs(Math.log(r.height / r.width / 1.25)) : Infinity;
    };
    const pick = boards.reduce((best, l) => (score(l) < score(best) - 0.01 ? l : best), boards[boards.length - 1]);
    if (Number.isFinite(score(pick))) {
      frame = rectOf(pick);
      roots = [pick];
      if (boards.length > 1) {
        boardNote = `This PSD has ${boards.length} artboards — imported "${pick.name ?? 'Artboard'}" (${frame.width}x${frame.height}). Import the others as separate files.`;
      }
    }
  }
  const ox = frame.left;
  const oy = frame.top;
  const S = W / frame.width;
  const H = Math.max(1, Math.round(frame.height * S));
  const composite = (): HTMLCanvasElement | undefined => {
    let c: HTMLCanvasElement | undefined = psd.canvas;
    if (!c) {
      try {
        c = ag.getCompositeCanvas(psd);
      } catch {
        c = undefined;
      }
    }
    if (!c || (!ox && !oy && c.width === frame.width && c.height === frame.height)) return c;
    const out = makeCanvas(frame.width, frame.height);
    ctx2d(out).drawImage(c, -ox, -oy);
    return out;
  };

  if (!psd.children?.length) {
    const comp = composite();
    if (!comp) throw new ImportError(`${file.name} has no layers and no flattened image to import.`);
    return flatResult(file, comp, W, H, 'the PSD has no layers.');
  }

  await ensureBrandFonts();

  // ---- walk the tree (children[0] = bottom) ----
  interface Leaf {
    l: PsdLayer;
    opacity: number;
    base?: PsdLayer;
  }
  const leaves: Leaf[] = [];
  let hiddenCount = 0;
  let adjustments = 0;
  let groupMasks = 0;
  const countLeaves = (l: PsdLayer): number => (l.children ? l.children.reduce((n, c) => n + countLeaves(c), 0) : 1);
  const walk = (children: PsdLayer[], opacity: number) => {
    let base: PsdLayer | undefined;
    for (const l of children) {
      if (!l.clipping) base = l;
      if (l.children) {
        if (l.hidden) hiddenCount += countLeaves(l);
        else {
          if (l.mask && !l.mask.disabled) groupMasks++;
          walk(l.children, opacity * (l.opacity ?? 1));
        }
        continue;
      }
      if (l.hidden || (l.clipping && base?.hidden)) {
        hiddenCount++;
        continue;
      }
      if (l.adjustment) {
        adjustments++;
        continue;
      }
      leaves.push({ l, opacity: opacity * (l.opacity ?? 1) * (l.fillOpacity ?? 1), base: l.clipping && base && !base.children ? base : undefined });
    }
  };
  walk(roots, 1);

  // ---- decode + convert leaves ----
  const items: Item[] = [];
  let empty = 0;
  let masks = 0;
  let clips = 0;
  let estimated = 0;
  const rasterized: string[] = [];
  let effects = 0;
  const blends = new Set<string>();
  let lastBase: { l: PsdLayer; p: Placed } | null = null;

  for (let i = 0; i < leaves.length; i++) {
    const { l, opacity, base } = leaves[i];
    if (i % 4 === 3) await yieldToBrowser();
    if (l.effects && !l.effects.disabled && Object.keys(l.effects).some((k) => k !== 'disabled' && k !== 'scale')) effects++;
    if (l.blendMode && l.blendMode !== 'normal' && l.blendMode !== 'pass through') blends.add(l.blendMode);

    let placed: Placed | undefined;
    const c = layerCanvas(ag, l);
    if (c && c.width > 0 && c.height > 0) placed = { canvas: c, left: l.left ?? 0, top: l.top ?? 0 };
    else placed = solidFill(ag, l, psd);
    if (placed && l.mask && !l.mask.disabled && placed.canvas === c) {
      placed = applyMask(ag, l, placed);
      masks++;
    }
    if (placed && base) {
      if (lastBase && lastBase.l === base) {
        placed = clipTo(placed, lastBase.p);
        clips++;
      }
    } else if (placed && !l.clipping) {
      lastBase = { l, p: placed };
    }

    const raster = placed
      ? {
          canvas: S < 1 ? scaleCanvas(placed.canvas, placed.canvas.width * S, placed.canvas.height * S) : placed.canvas,
          x: (placed.left - ox) * S,
          y: (placed.top - oy) * S,
          w: placed.canvas.width * S,
          h: placed.canvas.height * S,
        }
      : undefined;

    if (l.text) {
      const read = readPsdText(l, S, ox, oy);
      if (read && 'spec' in read) {
        if (read.estimated) estimated++;
        items.push({ type: 'text', spec: read.spec, opacity, raster });
        continue;
      }
      if (read && 'rasterize' in read) rasterized.push(read.rasterize);
      else if (!read && !raster) {
        empty++;
        continue;
      }
    }
    if (!raster || isBlank(raster.canvas)) {
      empty++;
      continue;
    }
    items.push({
      type: 'image',
      name: l.name || `Layer ${i + 1}`,
      canvas: raster.canvas,
      x: raster.x,
      y: raster.y,
      w: raster.w,
      h: raster.h,
      opacity,
      full: placed && placed.canvas.width * placed.canvas.height <= 4e6 ? placed.canvas : undefined,
    });
  }

  if (!items.length) {
    const comp = composite();
    if (!comp) throw new ImportError(`${file.name} has no visible layers to import.`);
    const why = hiddenCount || adjustments ? 'none of its layers could be converted (all hidden, empty or adjustment layers).' : 'the PSD has no layers with content.';
    return flatResult(file, comp, W, H, why);
  }

  // ---- cap: merge the bottom layers into one image ----
  let merged = 0;
  if (items.length > MAX_LEAVES) {
    const k = items.length - (MAX_LEAVES - 1);
    const bottom = items.splice(0, k);
    merged = k;
    items.unshift({ type: 'image', name: `Merged ${k} bottom layers`, canvas: drawItems(bottom, W, H, true), x: 0, y: 0, w: W, h: H, opacity: 1 });
  }

  // ---- preview + "what's behind each text" ----
  // A missing composite reads back as one flat colour (ag-psd writes zeros, Photoshop a blank sheet): composite ourselves.
  const comp = composite();
  const preview = comp && !isUniform(comp) ? scaleCanvas(comp, W, H) : drawItems(items, W, H, true);
  const behind = new PixelSampler(drawItems(items, W, H, false), W);

  // ---- build layers bottom -> top ----
  const nextId = idMaker();
  const fonts = new Map<string, string>();
  const layers: Layer[] = [];
  const uploads: { make: () => Promise<Uploaded>; apply: (u: Uploaded) => void }[] = [];
  const consumed = new Set<number>();
  let texts = 0;
  let images = 0;
  let buttons = 0;
  let snapped = 0;

  // CTA detection: short single-line text directly above a small, solid, box-like pixel layer that contains it.
  const buttonFor = new Map<number, { img: number; colour: RGB; radius: number }>();
  items.forEach((it, i) => {
    if (it.type !== 'text' || it.spec.paragraph || it.spec.text.includes('\n') || it.spec.text.split(/\s+/).length > 6) return;
    const s = it.spec;
    const tb = { x: s.left, y: (s.baseline ?? (s.top ?? 0) + s.fontPx * 0.72) - s.fontPx * 0.75, w: s.right - s.left, h: s.fontPx * 0.95 };
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const b = items[j];
      if (b.type !== 'image' || consumed.has(j)) continue;
      const pad = 2;
      const inside = tb.x >= b.x - pad && tb.x + tb.w <= b.x + b.w + pad && tb.y >= b.y - pad && tb.y + tb.h <= b.y + b.h + pad;
      if (!inside || b.w * b.h > W * H * 0.12 || b.h > s.fontPx * 3.5 || !b.full) continue;
      const st = solidStats(b.full);
      if (!st || st.solid < 0.9 || st.coverage < 0.8) continue;
      buttonFor.set(i, { img: j, colour: st.colour, radius: Math.min(st.radius * S, b.h / 2) });
      consumed.add(j);
      break;
    }
  });

  items.forEach((it, i) => {
    if (consumed.has(i)) return;
    if (it.type === 'image') {
      const layer: ImageLayer = {
        id: nextId('image'),
        kind: 'image',
        name: it.name,
        src: '',
        x: r1(it.x),
        y: r1(it.y),
        width: r1(it.w),
        height: r1(it.h),
      };
      if (it.opacity < 0.99) layer.opacity = r2(it.opacity);
      if (!layers.length) {
        layer.role = 'flat-image';
        layer.locked = false;
      }
      layers.push(layer);
      const canvas = it.canvas;
      uploads.push({ make: () => uploadCanvas(canvas, it.name), apply: (u) => (layer.src = u.url) });
      images++;
      return;
    }
    const btn = buttonFor.get(i);
    if (btn) {
      const b = items[btn.img] as Extract<Item, { type: 'image' }>;
      const layer: ButtonLayer = {
        id: nextId('button'),
        kind: 'button',
        role: 'cta',
        name: it.spec.name,
        x: r1(b.x),
        y: r1(b.y),
        width: r1(b.w),
        height: r1(b.h),
        text: it.spec.text,
        fill: nearestToken(btn.colour, ALL_TOKENS),
        textFill: snapTextColour(it.spec.fill, btn.colour),
        fontSize: r1(it.spec.fontPx),
        cornerRadius: r1(btn.radius),
      };
      if (b.opacity < 0.99) layer.opacity = r2(b.opacity);
      layers.push(layer);
      buttons++;
      return;
    }
    const spec = { ...it.spec, opacity: it.opacity };
    if (!isBrandTextColour(spec.fill)) snapped++;
    layers.push(buildTextLayer(spec, nextId('text'), W, fonts, behind));
    texts++;
  });

  let previewUrl = '';
  uploads.push({ make: () => uploadCanvas(preview, `${baseName(file.name)}-preview`), apply: (u) => (previewUrl = u.url) });
  const results = await pool(uploads, UPLOAD_CONCURRENCY, (u) => u.make());
  results.forEach((u, i) => uploads[i].apply(u));

  const design: Design = {
    id: `import-${Date.now().toString(36)}`,
    name: baseName(file.name),
    width: W,
    height: H,
    background: backgroundOf(preview),
    layers,
  };

  const size = frame.width === W ? `${W}x${H}` : `${frame.width}x${frame.height} -> ${W}x${H}`;
  const parts = [plural(texts, 'text'), buttons ? plural(buttons, 'button') : '', plural(images, 'image')].filter(Boolean).join(', ');
  const notes = [`Imported ${file.name} (${size}) as ${plural(layers.length, 'editable layer')} (${parts}).`];
  if (boardNote) notes.push(boardNote);
  if (hiddenCount) notes.push(`${plural(hiddenCount, 'hidden layer')} skipped.`);
  if (adjustments) notes.push(`${plural(adjustments, 'adjustment layer')} ignored (their effect only shows in the preview).`);
  if (merged) notes.push(`Merged the bottom ${merged} layers into one image (the editor keeps at most ${MAX_LEAVES} layers).`);
  if (buttons) notes.push(`${plural(buttons, 'label + box pair')} turned into editable CTA ${buttons === 1 ? 'button' : 'buttons'}.`);
  if (masks || clips) notes.push(`Applied ${[masks ? plural(masks, 'layer mask') : '', clips ? plural(clips, 'clipping mask') : ''].filter(Boolean).join(' and ')} to the layer images.`);
  if (effects) notes.push(`Layer effects (shadows, strokes, overlays) on ${plural(effects, 'layer')} aren't editable — they only show in the preview.`);
  if (blends.size) notes.push(`Blend modes shown as normal: ${[...blends].join(', ')}.`);
  if (groupMasks) notes.push(`${plural(groupMasks, 'group mask')} ignored.`);
  if (rasterized.length) notes.push(`${plural(rasterized.length, 'text layer')} (${[...new Set(rasterized)].join(', ')}) kept as images.`);
  if (estimated) notes.push(`Font size estimated from the pixels for ${plural(estimated, 'text layer')}.`);
  if (empty) notes.push(`${plural(empty, 'empty layer')} skipped.`);
  const fn = fontNote(fonts);
  if (fn) notes.push(fn);
  if (snapped) notes.push('Text colours snapped to brand navy/white.');
  return { kind: 'psd', design, previewUrl, notes };
}
