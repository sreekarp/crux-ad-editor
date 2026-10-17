// Shared helpers for file import (browser only): uploads, canvas, colour snapping, font mapping, text boxes.
import { FONTS, PALETTE } from '../brand';
import type { ColourToken, CoreColour, TextLayer } from '../types';

export const DESIGN_W = 1080;
/** Hard cap on what we try to import at all. */
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;
/** Backend /api/upload rejects anything over 25 MB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 - 64 * 1024;
export const UPLOAD_CONCURRENCY = 4;

/** Error whose message is already friendly enough to show in the chat. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || 'Import';
export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'layer';
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Lets the browser paint between heavy synchronous steps (PSD decoding). */
export const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

/** 'text' -> text-1, text-2 ... */
export function idMaker() {
  const counts: Record<string, number> = {};
  return (prefix: string) => `${prefix}-${(counts[prefix] = (counts[prefix] ?? 0) + 1)}`;
}

// ---------------------------------------------------------------------------------------------
// Upload

export interface Uploaded {
  url: string;
  w: number;
  h: number;
}

class RetryableUpload extends ImportError {}

const UPLOAD_TIMEOUT_MS = 60_000;

async function uploadOnce(blob: Blob, filename: string): Promise<Uploaded> {
  const form = new FormData();
  form.append('file', blob, filename);
  let res: Response;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    res = await fetch('/api/upload', { method: 'POST', body: form, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new RetryableUpload(`Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s — the backend isn't responding.`);
    throw new RetryableUpload('Could not reach the backend to upload images — is the API server running on :8000?');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      if (j && typeof j.detail === 'string') detail = j.detail;
    } catch {
      /* not JSON */
    }
    const msg = `Upload failed (${res.status}${detail ? `: ${detail}` : ''}).`;
    throw res.status >= 500 ? new RetryableUpload(msg) : new ImportError(msg);
  }
  const j = (await res.json().catch(() => null)) as Uploaded | null;
  if (!j || typeof j.url !== 'string') throw new ImportError('Upload failed: unexpected response from the backend.');
  return j;
}

/** POST /api/upload (one retry on network/5xx errors). */
export async function uploadBlob(blob: Blob, filename: string): Promise<Uploaded> {
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new ImportError(`An image in this file is too large to upload (${(blob.size / 1048576).toFixed(1)} MB, max 25 MB).`);
  }
  try {
    return await uploadOnce(blob, filename);
  } catch (e) {
    if (!(e instanceof RetryableUpload)) throw e;
    await sleep(400);
    return uploadOnce(blob, filename);
  }
}

export async function uploadCanvas(c: HTMLCanvasElement, name: string): Promise<Uploaded> {
  const blob = await canvasToBlob(c, 'image/png');
  return uploadBlob(blob, `${slug(name)}.png`);
}

/** Runs fn over items with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Canvas

type Drawable = HTMLCanvasElement | HTMLImageElement | ImageBitmap;

export function sizeOf(src: Drawable): { w: number; h: number } {
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
  return { w: src.width, h: src.height };
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, willReadFrequently = false): CanvasRenderingContext2D {
  const g = c.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined);
  if (!g) throw new ImportError('This browser could not create a drawing canvas (out of memory?).');
  return g;
}

/** High-quality resize (halving steps for big downscales so thin details don't alias). */
export function scaleCanvas(src: Drawable, w: number, h: number): HTMLCanvasElement {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  let cur: Drawable = src;
  let { w: cw, h: ch } = sizeOf(src);
  while (cw / 2 >= W * 1.5 && ch / 2 >= H * 1.5) {
    const half = makeCanvas(cw / 2, ch / 2);
    const g = ctx2d(half);
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
    cw = half.width;
    ch = half.height;
  }
  const out = makeCanvas(W, H);
  const g = ctx2d(out);
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, W, H);
  return out;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      c.toBlob((b) => (b ? resolve(b) : reject(new ImportError('Could not encode an image (canvas too large?).'))), type, quality);
    } catch (e) {
      reject(new ImportError(`Could not encode an image: ${errorText(e)}`));
    }
  });
}

export function loadImage(url: string, timeoutMs = 20_000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = window.setTimeout(() => reject(new ImportError('Timed out loading an image.')), timeoutMs);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new ImportError('Could not decode an image.'));
    };
    img.decoding = 'async';
    img.src = url;
  });
}

/** True when every pixel has (nearly) the same colour — e.g. a PSD saved without a real composite. */
export function isUniform(c: HTMLCanvasElement): boolean {
  const s = scaleCanvas(c, Math.min(c.width, 64), Math.min(c.height, 64));
  const d = ctx2d(s, true).getImageData(0, 0, s.width, s.height).data;
  for (let i = 4; i < d.length; i += 4) {
    if (Math.abs(d[i] - d[0]) > 3 || Math.abs(d[i + 1] - d[1]) > 3 || Math.abs(d[i + 2] - d[2]) > 3 || Math.abs(d[i + 3] - d[3]) > 3) return false;
  }
  return true;
}

/** True when (almost) every pixel is transparent. */
export function isBlank(c: HTMLCanvasElement): boolean {
  const s = scaleCanvas(c, Math.min(c.width, 128), Math.min(c.height, 128));
  const d = ctx2d(s, true).getImageData(0, 0, s.width, s.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Colour

export type RGB = [number, number, number];

export function hexRgb(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let scratch: CanvasRenderingContext2D | null = null;
function scratchCtx(): CanvasRenderingContext2D {
  if (!scratch) scratch = ctx2d(makeCanvas(4, 4), true);
  return scratch;
}

/** CSS colour (computed rgb()/hex/named) -> RGB; null for none/transparent/gradients. */
export function parseCssColour(s: string | null | undefined): RGB | null {
  if (!s) return null;
  const v = s.trim();
  if (!v || v === 'none' || v === 'transparent' || v.startsWith('url(') || v.startsWith('url (')) return null;
  const m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return hexRgb(v);
  // Named colours and other syntaxes: let the canvas parse it.
  const g = scratchCtx();
  g.fillStyle = '#010203';
  g.fillStyle = v;
  const out = String(g.fillStyle);
  if (out === '#010203') return null;
  if (out.startsWith('#')) return hexRgb(out);
  return out.startsWith('rgb') ? parseCssColour(out) : null;
}

const lin = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
export const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** CIE L* (0 = black, 100 = white). */
export function lightness(rgb: RGB): number {
  const y = luminance(rgb);
  return y <= 216 / 24389 ? (y * 24389) / 27 : 116 * Math.cbrt(y) - 16;
}
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toLab([r, g, b]: RGB): [number, number, number] {
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE(a: RGB, b: RGB): number {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export function nearestToken<T extends ColourToken>(rgb: RGB, tokens: readonly T[]): T {
  let best = tokens[0];
  let bestD = Infinity;
  for (const t of tokens) {
    const d = deltaE(rgb, hexRgb(PALETTE[t]));
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

export const CORE: readonly CoreColour[] = ['navy', 'blue', 'sky', 'white'];
export const ALL_TOKENS: readonly ColourToken[] = ['navy', 'blue', 'sky', 'white', 'mint', 'yellow', 'pink', 'lilac'];
export const nearestCore = (rgb: RGB): CoreColour => nearestToken(rgb, CORE);

const NAVY = hexRgb(PALETTE.navy);
const WHITE = hexRgb(PALETTE.white);

/** Already (close to) brand navy or white? */
export function isBrandTextColour(rgb: RGB | null): boolean {
  return !rgb || Math.min(deltaE(rgb, NAVY), deltaE(rgb, WHITE)) < 5;
}

/**
 * Brand text is navy or white only. Snap by lightness; when the source colour is mid-tone (or unknown)
 * or the pick would be unreadable on what's behind it, let the background decide.
 */
export function snapTextColour(fill: RGB | null, behind?: RGB | null): 'navy' | 'white' {
  const L = fill ? lightness(fill) : 50;
  let pick: 'navy' | 'white' = L >= 50 ? 'white' : 'navy';
  if (behind) {
    const cNavy = contrastRatio(NAVY, behind);
    const cWhite = contrastRatio(WHITE, behind);
    const cPick = pick === 'navy' ? cNavy : cWhite;
    const cOther = pick === 'navy' ? cWhite : cNavy;
    const ambiguous = !fill || Math.abs(L - 50) < 12;
    if ((ambiguous && cOther > cPick) || (cPick < 2 && cOther >= 3)) pick = pick === 'navy' ? 'white' : 'navy';
  }
  return pick;
}

/** Downscaled pixel snapshot of a design-sized canvas, for "what colour is behind this box" questions. */
export class PixelSampler {
  private data: Uint8ClampedArray;
  readonly w: number;
  readonly h: number;
  private k: number;

  constructor(canvas: HTMLCanvasElement, designW: number, maxW = 360) {
    this.w = Math.max(1, Math.min(maxW, canvas.width));
    this.h = Math.max(1, Math.round((canvas.height * this.w) / canvas.width));
    this.k = this.w / designW;
    const small = scaleCanvas(canvas, this.w, this.h);
    this.data = ctx2d(small, true).getImageData(0, 0, this.w, this.h).data;
  }

  /** Pixel composited over white (the design background behind transparent areas is unknown). */
  private px(x: number, y: number): RGB {
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const a = d[i + 3] / 255;
    return [d[i] * a + 255 * (1 - a), d[i + 1] * a + 255 * (1 - a), d[i + 2] * a + 255 * (1 - a)];
  }

  private dominant(points: [number, number][]): RGB {
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (const [x, y] of points) {
      const [r, g, b] = this.px(x, y);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
      buckets.set(key, e);
    }
    let best = { n: 0, r: 255, g: 255, b: 255 };
    for (const e of buckets.values()) if (e.n > best.n) best = e;
    return best.n ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
  }

  /** Dominant colour inside a box given in design pixels. */
  boxColour(box: { x: number; y: number; width: number; height: number }): RGB | null {
    const x0 = clamp(Math.floor(box.x * this.k), 0, this.w - 1);
    const y0 = clamp(Math.floor(box.y * this.k), 0, this.h - 1);
    const x1 = clamp(Math.ceil((box.x + box.width) * this.k), 0, this.w - 1);
    const y1 = clamp(Math.ceil((box.y + box.height) * this.k), 0, this.h - 1);
    if (x1 < x0 || y1 < y0) return null;
    const pts: [number, number][] = [];
    const sx = Math.max(1, (x1 - x0) / 24);
    const sy = Math.max(1, (y1 - y0) / 24);
    for (let y = y0; y <= y1; y += sy) for (let x = x0; x <= x1; x += sx) pts.push([Math.round(x), Math.round(y)]);
    return this.dominant(pts);
  }

  /** Dominant colour of the 2px border ring. */
  edgeColour(): RGB {
    const pts: [number, number][] = [];
    const { w, h } = this;
    for (let x = 0; x < w; x++) pts.push([x, 0], [x, Math.min(1, h - 1)], [x, h - 1], [x, Math.max(0, h - 2)]);
    for (let y = 0; y < h; y++) pts.push([0, y], [Math.min(1, w - 1), y], [w - 1, y], [Math.max(0, w - 2), y]);
    return this.dominant(pts);
  }
}

/** design.background = nearest core colour to the flattened image's dominant edge colour. */
export function backgroundOf(flat: HTMLCanvasElement | null): CoreColour {
  if (!flat) return 'white';
  try {
    return nearestCore(new PixelSampler(flat, flat.width, 200).edgeColour());
  } catch {
    return 'white';
  }
}

// ---------------------------------------------------------------------------------------------
// Fonts

const WEIGHT_WORDS: [RegExp, number][] = [
  [/hairline|thin/i, 100],
  [/extra\s*-?light|ultra\s*-?light/i, 200],
  [/semi\s*-?bold|demi\s*-?bold/i, 600],
  [/extra\s*-?bold|ultra\s*-?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
  [/light/i, 300],
  [/regular|book|roman|normal/i, 400],
];

/** 'National2Condensed-Bold' -> 700, 'Inter-SemiBold' -> 600, 'ArialMT' -> undefined. */
export function weightFromName(name: string): number | undefined {
  for (const [re, w] of WEIGHT_WORDS) if (re.test(name)) return w;
  return undefined;
}

/** CSS font-weight (computed) -> number. */
export function parseWeight(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  if (v === 'bold' || v === 'bolder') return 700;
  if (v === 'normal' || v === 'lighter') return 400;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 'National2Condensed-Bold' -> 'National 2 Condensed Bold'; '"Inter", sans-serif' -> 'Inter'. */
export function prettyFontName(name: string): string {
  let s = (name.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!/\s/.test(s)) {
    s = s
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
      .replace(/([0-9])([A-Za-z])/g, '$1 $2')
      .replace(/\b(MT|PS)\b/g, '');
  }
  return s.replace(/\s+/g, ' ').trim() || 'Unknown font';
}

/** Family without weight/style words: 'National 2 Condensed Bold' -> 'National 2 Condensed'. */
export function fontFamilyOnly(name: string): string {
  const s = prettyFontName(name)
    .replace(
      /\b(hairline|thin|extra\s*light|ultra\s*light|light|regular|book|roman|normal|medium|semi\s*bold|demi\s*bold|extra\s*bold|ultra\s*bold|bold|black|heavy|italic|oblique)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return s || prettyFontName(name);
}

const CONDENSED_RE = /condensed|compressed|narrow|national|\bcond\b|\bcomp\b/i;

/** font-stretch '75%' / 'condensed' -> true. */
export function isCondensedStretch(stretch: string | undefined): boolean {
  if (!stretch) return false;
  if (/condensed|narrow|compressed/i.test(stretch)) return true;
  const p = parseFloat(stretch);
  return Number.isFinite(p) && p <= 87.5;
}

/**
 * Brand fonts only: 'headline' (Barlow Condensed 600-800) for condensed / heavy display faces,
 * otherwise 'body' (Inter 400-700).
 */
export function mapFont(
  sourceName: string,
  weight: number | undefined,
  sizePx: number,
  stretch?: string,
): { font: 'headline' | 'body'; fontWeight: number } {
  const w = weight ?? weightFromName(sourceName);
  const condensed = CONDENSED_RE.test(sourceName) || isCondensedStretch(stretch);
  const headline = condensed || ((w ?? 400) >= 700 && sizePx >= 48);
  if (headline) return { font: 'headline', fontWeight: clamp(Math.round((w ?? 800) / 100) * 100, 600, 800) };
  return { font: 'body', fontWeight: clamp(Math.round((w ?? 400) / 100) * 100, 400, 700) };
}

let fontsReady: Promise<void> | null = null;
/** Brand fonts must be loaded before measuring (otherwise widths come from a fallback font). */
export function ensureBrandFonts(): Promise<void> {
  if (!fontsReady) {
    fontsReady = (async () => {
      if (typeof document === 'undefined' || !document.fonts) return;
      const specs = [
        ...['600', '700', '800'].map((w) => `${w} 40px "${FONTS.headline}"`),
        ...['400', '500', '600', '700'].map((w) => `${w} 20px "${FONTS.body}"`),
      ];
      await Promise.race([Promise.all(specs.map((s) => document.fonts.load(s).catch(() => []))), sleep(5000)]);
    })();
  }
  return fontsReady;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const fontCss = (font: 'headline' | 'body', weight: number, size: number) =>
  `${weight} normal ${size}px "${FONTS[font]}"`; // same string Konva builds

function mctx(font: 'headline' | 'body', weight: number, size: number): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = ctx2d(makeCanvas(8, 8));
  measureCtx.font = fontCss(font, weight, size);
  return measureCtx;
}

export function lineWidth(text: string, font: 'headline' | 'body', weight: number, size: number, letterSpacing = 0): number {
  const g = mctx(font, weight, size);
  g.fontKerning = letterSpacing ? 'none' : 'auto';
  return g.measureText(text).width + letterSpacing * Array.from(text).length;
}

/** Distance from a Konva Text box top to the first baseline (Konva >= 9: alphabetic baseline, font box metrics of 'M'). */
export function konvaBaselineOffset(font: 'headline' | 'body', weight: number, size: number, lineHeight: number): number {
  const m = mctx(font, weight, size).measureText('M');
  const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? size * 0.91;
  const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? size * 0.21;
  return (asc - desc) / 2 + (lineHeight * size) / 2;
}

/** Number of lines Konva's greedy word wrap produces at maxWidth. */
export function wrappedLineCount(
  text: string,
  font: 'headline' | 'body',
  weight: number,
  size: number,
  letterSpacing: number,
  maxWidth: number,
): number {
  let n = 0;
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      n++;
      continue;
    }
    let line = words[0];
    n++;
    for (let i = 1; i < words.length; i++) {
      const cand = `${line} ${words[i]}`;
      if (lineWidth(cand, font, weight, size, letterSpacing) <= maxWidth) line = cand;
      else {
        n++;
        line = words[i];
      }
    }
  }
  return Math.max(1, n);
}

// ---------------------------------------------------------------------------------------------
// Text layers

/** Source text geometry in design pixels (unrotated frame), as read from SVG / PSD. */
export interface TextSpec {
  name: string;
  /** Lines joined with \n. */
  text: string;
  sourceFont: string;
  weight?: number;
  stretch?: string;
  fontPx: number;
  /** Source line spacing as a multiple of the font size. */
  lineHeight?: number;
  letterSpacing?: number;
  align: 'left' | 'center' | 'right';
  fill: RGB | null;
  opacity?: number;
  /** Horizontal extent of the source text (ink or advance box). */
  left: number;
  right: number;
  /** First baseline (preferred for vertical placement). */
  baseline?: number;
  /** Fallback vertical reference: 'ink' = top of the glyphs, 'box' = top of a paragraph box. */
  top?: number;
  topMode?: 'ink' | 'box';
  /** Paragraph text: fixed wrap width (left..right is the box). */
  paragraph?: boolean;
  /** Rotated text: maps local (unrotated) coordinates to design coordinates. */
  toDesign?: (x: number, y: number) => [number, number];
  rotation?: number;
}

/**
 * Source text -> brand TextLayer. Font is mapped to the brand faces; the box keeps the source's alignment
 * anchor and first baseline, and is widened (never narrowed) so Konva doesn't re-wrap explicit lines.
 */
export function buildTextLayer(
  spec: TextSpec,
  id: string,
  W: number,
  fonts: Map<string, string>,
  behind?: PixelSampler | null,
): TextLayer {
  const { font, fontWeight } = mapFont(spec.sourceFont, spec.weight, spec.fontPx, spec.stretch);
  fonts.set(fontFamilyOnly(spec.sourceFont), FONTS[font]);
  const fontSize = Math.max(4, r1(spec.fontPx));
  const lineHeight = r2(clamp(spec.lineHeight ?? (font === 'headline' ? 1.0 : 1.2), 0.85, 1.6));
  const ls = spec.letterSpacing && Math.abs(spec.letterSpacing) >= 0.1 ? r2(spec.letterSpacing) : 0;
  const text = spec.text;
  const lines = text.split('\n');
  const lhPx = fontSize * lineHeight;

  let width: number;
  let x: number;
  let nLines = lines.length;
  if (spec.paragraph) {
    width = Math.max(spec.right - spec.left, fontSize);
    x = spec.left;
    nLines = wrappedLineCount(text, font, fontWeight, fontSize, ls, width);
  } else {
    const measured = Math.max(...lines.map((l) => lineWidth(l, font, fontWeight, fontSize, ls)));
    width = Math.max(spec.right - spec.left, measured) + Math.max(2, fontSize * 0.04);
    const mid = (spec.left + spec.right) / 2;
    x = spec.align === 'center' ? mid - width / 2 : spec.align === 'right' ? spec.right - width : spec.left;
  }
  const height = nLines * lhPx;

  const offset = konvaBaselineOffset(font, fontWeight, fontSize, lineHeight);
  let y: number;
  if (spec.baseline !== undefined) y = spec.baseline - offset;
  else if (spec.top !== undefined && spec.topMode === 'box') y = spec.top;
  else if (spec.top !== undefined) y = spec.top + 0.72 * fontSize - offset; // ink top ~ cap height above baseline
  else y = 0;

  let rotation: number | undefined;
  if (spec.toDesign && spec.rotation) {
    [x, y] = spec.toDesign(x, y);
    rotation = r1(spec.rotation);
  } else {
    // Widening must not push on-canvas text off the edge (brand checker: off-canvas / safe-margin).
    if (x < 0 && spec.left >= -1) x = 0;
    if (x + width > W && spec.right <= W + 1) x = Math.max(0, W - width);
  }

  const box = { x, y, width, height };
  const bg = behind?.boxColour(box) ?? null;
  const layer: TextLayer = {
    id,
    kind: 'text',
    name: spec.name,
    x: r1(x),
    y: r1(y),
    width: r1(width),
    height: r1(height),
    text,
    font,
    fontSize,
    fontWeight,
    fill: snapTextColour(spec.fill, bg),
    align: spec.align,
    lineHeight,
  };
  if (ls) layer.letterSpacing = ls;
  if (rotation) layer.rotation = rotation;
  if (spec.opacity !== undefined && spec.opacity < 0.99) layer.opacity = r2(spec.opacity);
  return layer;
}

export function fontNote(fonts: Map<string, string>): string | null {
  if (!fonts.size) return null;
  const parts = [...fonts.entries()].map(([src, dst]) => (src === dst ? dst : `${src} -> ${dst}`));
  return `Fonts mapped to brand fonts: ${parts.join(', ')}.`;
}
