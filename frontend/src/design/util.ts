// Shared helpers: hashing, manifest lookups, geometry and "what is behind this point" tests. Pure.
import type { BloomShape, CharmColour, ColourToken, CoreColour, Layer, LogoColour, Manifest } from '../types';
import { BG_GRID, BLOOM_ASPECT, BLOOM_GRID } from './shapes';
import { DARK_COLOURS, LOGO_ON, LOGO_PILLS, PALETTE } from '../brand';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------------------------
// Determinism

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Manifest lookups (sane defaults when the manifest is missing)

export const DEFAULT_LOGO_ASPECT = 3.55;
export const DEFAULT_DEVICE_ASPECT = 0.75;

export function logoAspect(m: Manifest | null): number {
  const l = m?.logo;
  return l && l.w > 0 && l.h > 0 ? l.w / l.h : DEFAULT_LOGO_ASPECT;
}

export function bloomAspect(shape: BloomShape, m: Manifest | null): number {
  const b = m?.blooms?.find((x) => x.shape === shape);
  return b && b.w > 0 && b.h > 0 ? b.w / b.h : (BLOOM_ASPECT[shape] ?? 1.2);
}

export function bgAspect(bgId: string, m: Manifest | null): number {
  const b = m?.backgrounds?.find((x) => x.id === bgId);
  if (b && b.w > 0 && b.h > 0) return b.w / b.h;
  return BG_GRID[bgId]?.aspect === '9:16' ? 579 / 1028 : 1;
}

export function charmAspect(type: string, m: Manifest | null): number {
  const c = m?.charms?.find((x) => x.type === type);
  return c && c.w > 0 && c.h > 0 ? c.w / c.h : 1;
}

/** Map a requested charm onto one the manifest really has (when a manifest is present). */
export function resolveCharm(type: string, colour: CharmColour, m: Manifest | null): { charm: string; colour: CharmColour } {
  if (!m?.charms?.length) return { charm: type, colour };
  const found = m.charms.find((c) => c.type === type) ?? m.charms.find((c) => c.type === 'sparkle') ?? m.charms[0];
  const colours = Object.keys(found.colours ?? {}) as CharmColour[];
  return { charm: found.type, colour: colours.length && !colours.includes(colour) ? colours[0] : colour };
}

const SVG_ILLUS = ['illus_vacation', 'illus_tax_return', 'illus_anywhere_access'];

export function deviceInfo(id: string, m: Manifest | null): { src: string; aspect: number; cutout: boolean; id: string } {
  const d = m?.devices?.find((x) => x.id === id) ?? (m?.devices?.length ? undefined : undefined);
  if (d) return { id: d.id, src: d.src, aspect: d.w > 0 && d.h > 0 ? d.w / d.h : DEFAULT_DEVICE_ASPECT, cutout: d.cutout };
  // natural aspects of the shipped product images (manifest values), used when the manifest is missing
  const guess: Record<string, number> = {
    device_tablet_kitchen: 1.792,
    device_phone_hand_payments: 0.726,
    device_phone_hand_balance: 0.725,
    device_laptop_overview: 0.954,
    device_laptop_welcome: 1.056,
    device_tablet_hands_account: 0.893,
    device_tablet_hands_payments: 0.893,
  };
  return {
    id,
    src: `/static/brand/devices/${id}.png`,
    aspect: m?.devices?.length ? DEFAULT_DEVICE_ASPECT : (guess[id] ?? DEFAULT_DEVICE_ASPECT),
    cutout: id !== 'device_tablet_kitchen',
  };
}

export function illusInfo(id: string, m: Manifest | null): { src: string; aspect: number; id: string } {
  const d = m?.illustrations?.find((x) => x.id === id);
  if (d) return { id: d.id, src: d.src, aspect: d.w > 0 && d.h > 0 ? d.w / d.h : 1.2 };
  return { id, src: `/static/brand/illus/${id}.${SVG_ILLUS.includes(id) ? 'svg' : 'png'}`, aspect: 1.25 };
}

// ---------------------------------------------------------------------------------------------
// Colour helpers

export const isDark = (c: ColourToken) => (DARK_COLOURS as string[]).includes(c);
/** Text colour that passes contrast on a given colour. */
export const textOn = (c: ColourToken): 'navy' | 'white' => (isDark(c) ? 'white' : 'navy');

export function logoOptions(c: ColourToken): LogoColour[] {
  if (c in LOGO_ON) return LOGO_ON[c as CoreColour];
  return ['navy']; // accent blooms (mint/yellow/pink/lilac) are light
}

export const logoPairOk = (pill: LogoColour, colour: LogoColour) => LOGO_PILLS.some((p) => p.pill === pill && p.colour === colour);

function hexRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(v.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Snap any colour string (token, hex) to the nearest allowed token. */
export function snapColour<T extends string>(c: unknown, allowed: readonly T[]): T {
  if (typeof c === 'string' && (allowed as readonly string[]).includes(c)) return c as T;
  const named: Record<string, string> = { ...PALETTE, black: '#000000', green: PALETTE.mint, purple: PALETTE.lilac };
  const hex = typeof c === 'string' ? (c.startsWith('#') ? c : named[c.toLowerCase()]) : undefined;
  if (!hex || !/^#[0-9a-fA-F]{3,8}$/.test(hex)) return allowed[0];
  const [r, g, b] = hexRgb(hex);
  let best = allowed[0];
  let bd = Infinity;
  for (const a of allowed) {
    const ah = (PALETTE as Record<string, string>)[a] ?? named[a];
    if (!ah) continue;
    const [ar, ag, ab] = hexRgb(ah);
    const d = (ar - r) ** 2 + (ag - g) ** 2 + (ab - b) ** 2;
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** Top-left x/y for a box of w*h rotated by deg (around its top-left, Konva) so its centre lands on (cx, cy). */
export function rotatedOrigin(cx: number, cy: number, w: number, h: number, deg: number): { x: number; y: number } {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: cx - ((w / 2) * c - (h / 2) * s), y: cy - ((w / 2) * s + (h / 2) * c) };
}

/** Axis-aligned bounds of a (possibly rotated) layer box. */
export function bounds(l: Box & { rotation?: number }): { x0: number; y0: number; x1: number; y1: number } {
  const deg = l.rotation ?? 0;
  if (!deg) return { x0: l.x, y0: l.y, x1: l.x + l.width, y1: l.y + l.height };
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const pts = [
    [0, 0],
    [l.width, 0],
    [0, l.height],
    [l.width, l.height],
  ].map(([px, py]) => [l.x + px * c - py * s, l.y + px * s + py * c]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** World point -> local (u, v) in 0..1 of the layer's unrotated box (flips applied). */
function localUV(l: Layer, px: number, py: number): { u: number; v: number } {
  let dx = px - l.x;
  let dy = py - l.y;
  const deg = l.rotation ?? 0;
  if (deg) {
    const t = (-deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
  }
  let u = l.width ? dx / l.width : -1;
  let v = l.height ? dy / l.height : -1;
  if ('flipX' in l && l.flipX) u = 1 - u;
  if ('flipY' in l && l.flipY) v = 1 - v;
  return { u, v };
}

function gridHit(rows: string[] | undefined, u: number, v: number): boolean {
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  if (!rows?.length) return true;
  const r = rows[Math.min(rows.length - 1, Math.floor(v * rows.length))];
  return r[Math.min(r.length - 1, Math.floor(u * r.length))] === '1';
}

export type Behind = { busy: false; colour: ColourToken; layerId?: string } | { busy: true; colour: null; layerId: string };

/** What a layer of this kind shows at a world point (null = transparent there). */
export function surfaceAt(l: Layer, px: number, py: number): Behind | null {
  if (l.hidden || (l.opacity !== undefined && l.opacity < 0.35)) return null;
  const { u, v } = localUV(l, px, py);
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
  switch (l.kind) {
    case 'rect':
      return { busy: false, colour: l.fill, layerId: l.id };
    case 'stat':
      return { busy: false, colour: 'white', layerId: l.id };
    case 'button':
      return { busy: false, colour: l.fill, layerId: l.id };
    case 'bloom':
      return gridHit(BLOOM_GRID[l.shape], u, v) ? { busy: false, colour: l.colour, layerId: l.id } : null;
    case 'bgshape':
      return gridHit(BG_GRID[l.bgId]?.rows, u, v) ? { busy: false, colour: l.colour, layerId: l.id } : null;
    case 'photo':
      if (l.mask) return gridHit(BLOOM_GRID[l.mask], u, v) ? { busy: true, colour: null, layerId: l.id } : null;
      return { busy: true, colour: null, layerId: l.id };
    case 'image':
      // Cut-outs/illustrations: treat the inner area as busy.
      return u > 0.08 && u < 0.92 && v > 0.08 && v < 0.92 ? { busy: true, colour: null, layerId: l.id } : null;
    case 'charm':
      return (u - 0.5) ** 2 + (v - 0.5) ** 2 < 0.16 ? { busy: true, colour: null, layerId: l.id } : null;
    default:
      return null; // text, logo, tags: not backgrounds
  }
}

/** Topmost surface under (px, py) among layers[0..below). Falls back to the design background. */
export function behindPoint(layers: Layer[], below: number, px: number, py: number, background: CoreColour): Behind {
  for (let i = Math.min(below, layers.length) - 1; i >= 0; i--) {
    const s = surfaceAt(layers[i], px, py);
    if (s) return s;
  }
  return { busy: false, colour: background };
}

/** Sample a grid of points inside a box. */
export function samplePoints(b: Box, cols = 5, rows = 3, inset = 0.12): [number, number][] {
  const pts: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const fu = cols === 1 ? 0.5 : inset + ((1 - 2 * inset) * c) / (cols - 1);
      const fv = rows === 1 ? 0.5 : inset + ((1 - 2 * inset) * r) / (rows - 1);
      pts.push([b.x + b.width * fu, b.y + b.height * fv]);
    }
  return pts;
}

export interface BehindSummary {
  busy: boolean;
  busyLayer?: string;
  /** Most common solid colour among the samples. */
  colour: ColourToken;
  colours: ColourToken[];
}

export function behindBox(layers: Layer[], below: number, pts: [number, number][], background: CoreColour): BehindSummary {
  const counts = new Map<ColourToken, number>();
  let busyLayer: string | undefined;
  for (const [x, y] of pts) {
    const b = behindPoint(layers, below, x, y, background);
    if (b.busy) busyLayer ??= b.layerId;
    else counts.set(b.colour, (counts.get(b.colour) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    busy: busyLayer !== undefined,
    busyLayer,
    colour: sorted[0]?.[0] ?? background,
    colours: sorted.map((s) => s[0]),
  };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
