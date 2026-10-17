// Templates: Slots -> laid-out, layered Design. Pure. All geometry derives from W/H (fractions), so 4:5, 1:1 and 9:16
// share one code path; 9:16 keeps text/logo/CTA inside the Meta safe zone (SAFE.story).
import type {
  BgShapeLayer,
  BloomLayer,
  BloomShape,
  ButtonLayer,
  CharmLayer,
  CharmSpec,
  Colourway,
  CoreColour,
  Design,
  Hero,
  ImageLayer,
  Layer,
  LogoLayer,
  Manifest,
  PhotoLayer,
  RectLayer,
  Slots,
  StatLayer,
  StatSpec,
  TagsLayer,
  TemplateId,
  TextLayer,
} from '../types';
import { BLOOM_SHAPES, CTA_STYLES, DEFAULT_TAGS, MIN_FONT_PX_AT_1080, PHOTO_MASKS, SAFE } from '../brand';
import { BLOOM_GRID } from './shapes';
import { fitText, measureText, wrap } from './text';
import {
  type Box,
  behindBox,
  bgAspect,
  bloomAspect,
  charmAspect,
  deviceInfo,
  hashStr,
  illusInfo,
  logoAspect,
  logoOptions,
  overlaps,
  r1,
  resolveCharm,
  rng,
  rotatedOrigin,
  samplePoints,
  surfaceAt,
  textOn,
} from './util';

export interface Size {
  width: number;
  height: number;
}

const TEMPLATES: TemplateId[] = ['card', 'bold', 'checklist', 'split', 'offer'];
const COLOURWAYS: Colourway[] = ['light', 'dark', 'blue'];

/** Offer words that legally need a disclaimer (CONTRACT: disclaimer rule). */
export const OFFER_RE = /%|[£$€]\s?\d|\bR\s?\d|\bfree\b|\bvoucher|\boff\b|\*/i;

interface Palette {
  bg: CoreColour;
  text: 'navy' | 'white';
  /** Contrasting decorative bloom colour. */
  accent: CoreColour;
  /** Bloom behind a hero (depth). */
  back: CoreColour;
  cta: 'sky' | 'navy' | 'white';
}

const PALETTES: Record<Colourway, Palette> = {
  light: { bg: 'sky', text: 'navy', accent: 'blue', back: 'white', cta: 'navy' },
  dark: { bg: 'navy', text: 'white', accent: 'blue', back: 'blue', cta: 'sky' },
  blue: { bg: 'blue', text: 'white', accent: 'sky', back: 'sky', cta: 'sky' },
};

/** Effective colourway per template (unsupported combos -> closest). */
export function effectiveColourway(t: TemplateId, c: Colourway): Colourway {
  if (t === 'checklist') return c === 'light' ? 'dark' : c;
  if (t === 'split' || t === 'offer') return 'light';
  return c;
}

/** Clamp/repair LLM slots so layout never sees garbage. */
export function normalizeSlots(input: Slots): Slots {
  const s = { ...(input ?? ({} as Slots)) };
  const template: TemplateId = TEMPLATES.includes(s.template) ? s.template : 'card';
  const colourway: Colourway = COLOURWAYS.includes(s.colourway) ? s.colourway : 'light';
  const hero: Hero =
    s.hero && ['photo', 'device', 'illustration', 'none'].includes(s.hero.type) ? { ...s.hero } : { type: 'none' };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null);
  return {
    ...s,
    template,
    colourway: effectiveColourway(template, colourway),
    headline: str(s.headline) ?? 'Run your business, not your books.',
    headline2: str(s.headline2),
    sub: str(s.sub),
    cta: str(s.cta) ?? 'Find out more',
    disclaimer: str(s.disclaimer),
    items: Array.isArray(s.items) ? s.items.map(str).filter((x): x is string => !!x).slice(0, 3) : null,
    charms: Array.isArray(s.charms)
      ? s.charms.filter((c) => c && typeof c.charm === 'string' && c.charm).slice(0, 3)
      : [],
    bloom: s.bloom && BLOOM_SHAPES.includes(s.bloom) ? s.bloom : undefined,
    hero,
    stat: s.stat && s.stat.label && s.stat.value ? s.stat : null,
  };
}

export function needsDisclaimer(s: Slots): boolean {
  return [s.headline, s.headline2, s.sub, s.cta].some((t) => !!t && OFFER_RE.test(t));
}

// ---------------------------------------------------------------------------------------------
// Build context

interface Ctx {
  W: number;
  H: number;
  s: Slots;
  m: Manifest | null;
  /** Safe text frame. */
  F: { x0: number; y0: number; x1: number; y1: number };
  story: boolean;
  square: boolean;
  layers: Layer[];
  counts: Record<string, number>;
  rnd: () => number;
  pal: Palette;
  logoA: number;
  minFont: number;
}

function nid(ctx: Ctx, role: string): string {
  ctx.counts[role] = (ctx.counts[role] ?? 0) + 1;
  return `${role}-${ctx.counts[role]}`;
}

function push<L extends Layer>(ctx: Ctx, l: L): L {
  ctx.layers.push(l);
  return l;
}

const pick = <T,>(ctx: Ctx, arr: readonly T[]): T => arr[Math.floor(ctx.rnd() * arr.length) % arr.length];

// ---------------------------------------------------------------------------------------------
// Element builders (return layers; caller pushes in z-order)

function headlineLayer(
  ctx: Ctx,
  text: string,
  o: {
    x: number;
    y: number;
    width: number;
    base: number;
    maxLines: number;
    preferLines?: number;
    preferMinScale?: number;
    align?: 'left' | 'center' | 'right';
    fill: 'navy' | 'white';
    role?: 'headline' | 'headline2';
  },
): TextLayer {
  const fit = fitText(text, {
    base: o.base,
    maxWidth: o.width,
    maxLines: o.maxLines,
    preferLines: o.preferLines,
    preferMinScale: o.preferMinScale,
    lineHeight: 0.98,
  });
  return {
    id: nid(ctx, o.role ?? 'headline'),
    kind: 'text',
    role: o.role ?? 'headline',
    text: fit.text,
    font: 'headline',
    fontSize: fit.fontSize,
    fontWeight: 800,
    fill: o.fill,
    align: o.align ?? 'left',
    lineHeight: 0.98,
    letterSpacing: fit.letterSpacing,
    x: r1(o.x),
    y: r1(o.y),
    width: r1(o.width),
    height: r1(fit.height),
  };
}

function bodyLayer(
  ctx: Ctx,
  role: 'sub' | 'disclaimer' | 'row-text',
  text: string,
  o: {
    x: number;
    y: number;
    width: number;
    size: number;
    weight?: number;
    maxLines?: number;
    align?: 'left' | 'center' | 'right';
    fill: 'navy' | 'white';
    lineHeight?: number;
    font?: 'headline' | 'body';
  },
): TextLayer {
  const font = o.font ?? 'body';
  const lineHeight = o.lineHeight ?? (font === 'body' ? 1.3 : 1.0);
  const fit = fitText(text, {
    base: o.size,
    font,
    weight: o.weight ?? 500,
    maxWidth: o.width,
    maxLines: o.maxLines ?? 4,
    minScale: Math.min(1, Math.max(0.7, ctx.minFont / o.size)),
    lineHeight,
    balance: false,
    trackingEm: font === 'headline' ? -0.005 : 0,
  });
  return {
    id: nid(ctx, role),
    kind: 'text',
    role,
    text: fit.text,
    font,
    fontSize: fit.fontSize,
    fontWeight: o.weight ?? 500,
    fill: o.fill,
    align: o.align ?? 'left',
    lineHeight,
    letterSpacing: fit.letterSpacing,
    x: r1(o.x),
    y: r1(o.y),
    width: r1(o.width),
    height: r1(fit.height),
  };
}

/** CTA proportions measured on the refs (fractions of W). */
export const CTA_FONT = 0.036;
export const CTA_HEIGHT = 0.078;
export const CTA_PAD_X = 0.044;

function ctaMetrics(ctx: Ctx, text: string, maxW: number) {
  const { W } = ctx;
  let fs = W * CTA_FONT;
  const padX = W * CTA_PAD_X;
  let tw = measureText(text, 'body', 700, fs, 0);
  while (tw + 2 * padX > maxW && fs > ctx.minFont) {
    fs = Math.max(ctx.minFont, fs * 0.95);
    tw = measureText(text, 'body', 700, fs, 0);
  }
  return { fs: r1(fs), w: r1(Math.min(maxW, tw + 2 * padX)), h: r1(W * CTA_HEIGHT) };
}

function ctaLayer(ctx: Ctx, x: number, y: number, style: keyof typeof CTA_STYLES, maxW: number): ButtonLayer {
  const m = ctaMetrics(ctx, ctx.s.cta, maxW);
  const st = CTA_STYLES[style];
  return {
    id: nid(ctx, 'cta'),
    kind: 'button',
    role: 'cta',
    text: ctx.s.cta,
    fill: st.fill,
    textFill: st.textFill,
    fontSize: m.fs,
    cornerRadius: r1(ctx.W * 0.012),
    x: r1(x),
    y: r1(y),
    width: m.w,
    height: m.h,
  };
}

/** CTA style that is visible on `under` (falls back to the colourway default). */
function ctaStyleOn(ctx: Ctx, under: CoreColour | 'white', fallback?: 'sky' | 'navy' | 'white'): 'sky' | 'navy' | 'white' {
  const want = ctx.s.ctaStyle ?? fallback ?? ctx.pal.cta;
  if (want !== under) return want;
  const alt = (['sky', 'navy', 'white'] as const).find((c) => c !== under && c !== 'white') ?? 'navy';
  return under === 'white' ? 'sky' : alt;
}

function logoLayer(ctx: Ctx, x: number, y: number, w: number): LogoLayer {
  const h = w / ctx.logoA;
  const l: LogoLayer = {
    id: nid(ctx, 'logo'),
    kind: 'logo',
    role: 'logo',
    colour: 'navy',
    pill: null,
    x: r1(x),
    y: r1(y),
    width: r1(w),
    height: r1(h),
  };
  colourLogo(ctx, l);
  return l;
}

/** Logo colour from what is under it (LOGO_ON); pill when it sits on a photo/device or mixed colours. */
function colourLogo(ctx: Ctx, l: LogoLayer) {
  const b = behindBox(ctx.layers, ctx.layers.length, samplePoints(l, 6, 3, 0.06), ctx.pal.bg);
  const common = b.colours.length
    ? logoOptions(b.colours[0]).filter((c) => b.colours.every((k) => logoOptions(k).includes(c)))
    : [];
  if (!b.busy && common.length) {
    l.colour = common[0];
    l.pill = null;
  } else {
    l.pill = 'white';
    l.colour = 'navy';
  }
}

function tagsMetrics(ctx: Ctx, columns: 1 | 2 | 4, fs: number) {
  const longest = Math.max(...DEFAULT_TAGS.map((t) => measureText(t, 'headline', 700, fs, 0)));
  const cell = fs * 1.05 + fs * 0.35 + longest;
  const gap = fs * 0.9;
  const rows = Math.ceil(DEFAULT_TAGS.length / columns);
  return { w: r1(columns * cell + (columns - 1) * gap), h: r1(rows * fs * 1.35), fs: r1(fs) };
}

function tagsLayer(ctx: Ctx, x: number, y: number, columns: 1 | 2 | 4, fill: 'navy' | 'white', fs?: number): TagsLayer {
  const m = tagsMetrics(ctx, columns, Math.max(ctx.minFont, fs ?? ctx.W * 0.029));
  return {
    id: nid(ctx, 'tags'),
    kind: 'tags',
    role: 'tags',
    items: [...DEFAULT_TAGS],
    fill,
    columns,
    fontSize: m.fs,
    x: r1(x),
    y: r1(y),
    width: m.w,
    height: m.h,
  };
}

function statSize(ctx: Ctx, spec: StatSpec) {
  const { W } = ctx;
  return spec.variant === 'check' ? { w: W * 0.37, h: W * 0.115 } : { w: W * 0.29, h: W * 0.21 };
}

function statLayer(ctx: Ctx, spec: StatSpec, x: number, y: number): StatLayer {
  const { w, h } = statSize(ctx, spec);
  return {
    id: nid(ctx, 'stat'),
    kind: 'stat',
    role: 'stat',
    label: spec.label,
    value: spec.value,
    variant: spec.variant,
    x: r1(x),
    y: r1(y),
    width: r1(w),
    height: r1(h),
  };
}

function charmLayer(ctx: Ctx, spec: CharmSpec, cx: number, cy: number, size: number, rot = 0, role: 'charm' | 'decor' = 'charm'): CharmLayer {
  const c = resolveCharm(spec.charm, spec.colour, ctx.m);
  const a = charmAspect(c.charm, ctx.m);
  const w = a >= 1 ? size : size * a;
  const h = a >= 1 ? size / a : size;
  // keep the charm inside the canvas
  const cxs = Math.min(ctx.W - w * 0.55, Math.max(w * 0.55, cx));
  const cys = Math.min(ctx.H - h * 0.55, Math.max(h * 0.55, cy));
  const o = rotatedOrigin(cxs, cys, w, h, rot);
  return {
    id: nid(ctx, role),
    kind: 'charm',
    role,
    charm: c.charm,
    colour: c.colour,
    x: r1(o.x),
    y: r1(o.y),
    width: r1(w),
    height: r1(h),
    ...(rot ? { rotation: r1(rot) } : {}),
  };
}

function bloomLayer(
  ctx: Ctx,
  shape: BloomShape,
  colour: BloomLayer['colour'],
  x: number,
  y: number,
  w: number,
  o: { flipX?: boolean; flipY?: boolean; rotation?: number; role?: 'bloom' | 'bg-shape' } = {},
): BloomLayer {
  const h = w / bloomAspect(shape, ctx.m);
  return {
    id: nid(ctx, o.role ?? 'bloom'),
    kind: 'bloom',
    role: o.role ?? 'bloom',
    shape,
    colour,
    x: r1(x),
    y: r1(y),
    width: r1(w),
    height: r1(h),
    ...(o.flipX ? { flipX: true } : {}),
    ...(o.flipY ? { flipY: true } : {}),
    ...(o.rotation ? { rotation: r1(o.rotation) } : {}),
  };
}

/** Grow a bloom/photo box around an anchor (fractions of its box) until every point is covered by its shape. */
function growToCover<L extends BloomLayer | PhotoLayer | BgShapeLayer>(l: L, pts: [number, number][], ax: number, ay: number, maxSteps = 18): L {
  for (let i = 0; i < maxSteps; i++) {
    if (pts.every(([x, y]) => surfaceAt(l, x, y))) break;
    const nw = l.width * 1.07;
    const nh = l.height * 1.07;
    l.x = r1(l.x + ax * l.width - ax * nw);
    l.y = r1(l.y + ay * l.height - ay * nh);
    l.width = r1(nw);
    l.height = r1(nh);
  }
  return l;
}

/** Fraction extents of the shape's solid body (rows/cols at least `t` filled). */
function solidExtent(shape: BloomShape, t = 0.35) {
  const g = BLOOM_GRID[shape];
  const rows = g.length;
  const cols = g[0].length;
  const rowFill = g.map((r) => r.split('').filter((c) => c === '1').length / cols);
  const colFill = Array.from({ length: cols }, (_, c) => g.filter((r) => r[c] === '1').length / rows);
  const y0 = rowFill.findIndex((f) => f >= t) / rows;
  const x0 = colFill.findIndex((f) => f >= t) / cols;
  return { x0: Math.max(0, x0), y0: Math.max(0, y0) };
}

function photoLayer(ctx: Ctx, box: Box, mask: BloomShape | null, cornerRadius = 0): PhotoLayer {
  const hero = ctx.s.hero;
  const dev = hero.type === 'device' && hero.deviceId ? deviceInfo(hero.deviceId, ctx.m) : null;
  const src = dev ? dev.src : (hero.photoUrl ?? null);
  return {
    id: nid(ctx, 'photo'),
    kind: 'photo',
    role: 'photo',
    src,
    mask,
    ...(mask ? {} : { cornerRadius: r1(cornerRadius) }),
    zoom: 1,
    focusX: 0.5,
    focusY: dev ? 0.5 : 0.32,
    ...(hero.photoPrompt ? { prompt: hero.photoPrompt } : {}),
    status: src ? 'ready' : 'loading',
    x: r1(box.x),
    y: r1(box.y),
    width: r1(box.width),
    height: r1(box.height),
  };
}

function imageLayer(ctx: Ctx, role: 'device' | 'illustration', src: string, assetId: string, box: Box): ImageLayer {
  return {
    id: nid(ctx, role),
    kind: 'image',
    role,
    src,
    assetId,
    x: r1(box.x),
    y: r1(box.y),
    width: r1(box.width),
    height: r1(box.height),
  };
}

function bgShapeLayer(ctx: Ctx, bgId: string, colour: CoreColour, box: Box, o: { flipX?: boolean; flipY?: boolean } = {}): BgShapeLayer {
  return {
    id: nid(ctx, 'bg-shape'),
    kind: 'bgshape',
    role: 'bg-shape',
    bgId,
    colour,
    x: r1(box.x),
    y: r1(box.y),
    width: r1(box.width),
    height: r1(box.height),
    ...(o.flipX ? { flipX: true } : {}),
    ...(o.flipY ? { flipY: true } : {}),
  };
}

function rectLayer(ctx: Ctx, role: 'card' | 'row', box: Box, fill: RectLayer['fill'], r: number): RectLayer {
  return {
    id: nid(ctx, role),
    kind: 'rect',
    role,
    fill,
    cornerRadius: r1(r),
    x: r1(box.x),
    y: r1(box.y),
    width: r1(box.width),
    height: r1(box.height),
  };
}

/** Hero kind after resolving devices that are really photos (no cut-out). */
function heroKind(ctx: Ctx): 'photo' | 'device' | 'illustration' | 'none' {
  const h = ctx.s.hero;
  if (h.type === 'device') {
    if (!h.deviceId) return 'none';
    return deviceInfo(h.deviceId, ctx.m).cutout ? 'device' : 'photo';
  }
  if (h.type === 'illustration') return h.illustrationId ? 'illustration' : 'none';
  return h.type;
}

/** Device/illustration width from its aspect: phones ~0.58W, tablets ~0.66W, laptops ~0.72W, wide ~0.92W. */
function heroWidth(W: number, aspect: number): number {
  return W * Math.min(0.92, Math.max(0.5, 0.58 * Math.pow(aspect / 0.725, 0.6)));
}

function photoMask(ctx: Ctx): BloomShape {
  const b = ctx.s.bloom;
  return b && PHOTO_MASKS.includes(b) ? b : pick(ctx, PHOTO_MASKS);
}

function disclaimerText(ctx: Ctx): string | null {
  return ctx.s.disclaimer ?? (needsDisclaimer(ctx.s) ? 'Terms apply.' : null);
}

/** Charm specs (slots) with sensible defaults. */
function charmSpecs(ctx: Ctx, fallback: CharmSpec[]): CharmSpec[] {
  const c = ctx.s.charms ?? [];
  return c.length ? c : fallback;
}

/** Pick the first candidate position whose charm box avoids the given boxes. */
function placeCharm(ctx: Ctx, spec: CharmSpec, cands: [number, number][], size: number, avoid: Box[], rot: number): CharmLayer {
  let best: CharmLayer | null = null;
  for (const [cx, cy] of cands) {
    const l = charmLayer(ctx, spec, cx, cy, size, rot);
    ctx.counts.charm--; // only count the one we keep
    const hit = avoid.some((a) => overlaps(shrink(l, 0.15), a));
    if (!hit) {
      best = l;
      break;
    }
    best ??= l;
  }
  ctx.counts.charm = (ctx.counts.charm ?? 0) + 1;
  best!.id = `charm-${ctx.counts.charm}`;
  return best!;
}

/** One box per laid-out line (real ink extents, not the whole text box). Body text is wrapped at the box width. */
function lineBoxes(l: TextLayer): Box[] {
  const st = { font: l.font, weight: l.fontWeight, size: l.fontSize, letterSpacing: l.letterSpacing ?? 0 };
  const lines = l.font === 'body' ? wrap(l.text, st, l.width) : l.text.split('\n');
  const lh = l.fontSize * l.lineHeight;
  return lines.map((line, i) => {
    const lw = Math.min(l.width, measureText(line, l.font, l.fontWeight, l.fontSize, l.letterSpacing ?? 0));
    const x = l.align === 'center' ? l.x + (l.width - lw) / 2 : l.align === 'right' ? l.x + l.width - lw : l.x;
    return { x, y: l.y + i * lh, width: lw, height: lh };
  });
}

/** Points along each laid-out line of a text layer (its real extents, not the whole box), padded by pad. */
function lineSamples(l: TextLayer, pad: number): [number, number][] {
  const pts: [number, number][] = [];
  const lh = l.fontSize * l.lineHeight;
  l.text.split('\n').forEach((line, i) => {
    const lw = measureText(line, l.font, l.fontWeight, l.fontSize, l.letterSpacing ?? 0);
    const x0 = l.align === 'center' ? l.x + (l.width - lw) / 2 : l.align === 'right' ? l.x + l.width - lw : l.x;
    for (let k = 0; k <= 4; k++)
      for (const dy of [-0.5, 0, 0.5]) pts.push([x0 - pad + ((lw + 2 * pad) * k) / 4, l.y + (i + 0.5) * lh + dy * (lh / 2 + pad)]);
  });
  return pts;
}

/** First candidate box that does not overlap any of `busy` (null if none). */
function firstFree(cands: Box[], busy: Box[]): Box | null {
  return cands.find((c) => !busy.some((b) => overlaps(shrink(c, 0.004), b))) ?? null;
}

const shrink = (b: Box, f: number): Box => ({
  x: b.x + b.width * f,
  y: b.y + b.height * f,
  width: b.width * (1 - 2 * f),
  height: b.height * (1 - 2 * f),
});

const rot = (ctx: Ctx, max = 14) => Math.round((ctx.rnd() * 2 - 1) * max);

// ---------------------------------------------------------------------------------------------
// Template: card

function card(ctx: Ctx) {
  const { W, H, F, s, story, square, pal } = ctx;
  const kind = heroKind(ctx);
  const cardX = kind === 'none' ? W * 0.035 : F.x0;
  const cardW = kind === 'none' ? W * 0.93 : F.x1 - F.x0;
  const px = kind === 'none' ? W * 0.065 : W * 0.062;
  const pt = W * 0.07;
  const pb = W * 0.064;
  const innerW = cardW - 2 * px;
  const cardY = kind === 'none' ? 0 : F.y0; // none: computed below

  // --- text stack (measured)
  const hl = headlineLayer(ctx, s.headline, {
    x: cardX + px,
    y: 0,
    width: innerW,
    base: W * (kind === 'none' ? (square ? 0.11 : 0.122) : square ? 0.098 : 0.108),
    maxLines: story ? 4 : 3,
    preferLines: 2,
    fill: 'navy',
  });
  const sub = s.sub
    ? bodyLayer(ctx, 'sub', s.sub, { x: cardX + px, y: 0, width: innerW, size: W * 0.034, maxLines: 3, fill: 'navy' })
    : null;
  const ctaStyle = ctaStyleOn(ctx, 'white', 'sky');
  const ctaM = ctaMetrics(ctx, s.cta, innerW);
  const disc = disclaimerText(ctx);
  const discSize = Math.max(ctx.minFont, W * 0.026);
  const discW = disc ? measureText(disc, 'body', 500, discSize, 0) : 0;
  const discOnRow = !!disc && discW <= innerW - ctaM.w - W * 0.04;
  const discOutside = !!disc && !discOnRow && kind === 'none';
  const discBelow = !!disc && !discOnRow && !discOutside;
  let discLayer: TextLayer | null = null;
  if (disc && discBelow) {
    discLayer = bodyLayer(ctx, 'disclaimer', disc, { x: cardX + px, y: 0, width: innerW, size: discSize, maxLines: 2, fill: 'navy', lineHeight: 1.25 });
  }
  const ctaGap = sub ? W * 0.05 : W * 0.065;
  const contentH =
    pt + hl.height + (sub ? W * 0.026 + sub.height : 0) + ctaGap + ctaM.h + (discLayer ? W * 0.022 + discLayer.height : 0) + pb;
  const minH = kind === 'none' ? W * (square ? 0.5 : 0.6) : W * (square ? 0.44 : 0.54);
  const cardH = Math.max(contentH, minH);

  // --- vertical placement
  const logoW = W * (kind === 'none' ? 0.26 : 0.235);
  const logoH = logoW / ctx.logoA;
  let cy = cardY;
  if (kind === 'none') {
    // card floats between a top bloom and the logo row at the bottom
    const logoTop = F.y1 - logoH;
    const room = logoTop - W * 0.07 - F.y0;
    cy = F.y0 + Math.max(0, (room - cardH) * (story ? 0.35 : 0.62));
  }
  const cardBottom = cy + cardH;
  hl.y = r1(cy + pt);
  if (sub) sub.y = r1(hl.y + hl.height + W * 0.026);
  const ctaY = cardBottom - pb - (discLayer ? discLayer.height + W * 0.022 : 0) - ctaM.h;
  if (discLayer) discLayer.y = r1(ctaY + ctaM.h + W * 0.022);

  const radius = W * 0.045;
  const cardBox: Box = { x: cardX, y: cy, width: cardW, height: cardH };

  // --- background / hero layers (z-order bottom -> top)
  const stat = s.stat;
  let logoX = F.x1 - logoW;
  let logoY = cardBottom + W * 0.045;
  let tags: TagsLayer | null = null;
  const charms = charmSpecs(ctx, kind === 'none' ? [{ charm: 'sparkle', colour: 'yellow' }] : []);
  const charmLayers: CharmLayer[] = [];
  let statL: StatLayer | null = null;

  if (kind === 'photo') {
    const photoTop = cardBottom - radius - W * 0.004;
    const photo = photoLayer(ctx, { x: 0, y: photoTop, width: W, height: H - photoTop }, null, 0);
    push(ctx, photo);
    // left bloom: organic edge where the photo meets the colour field on the left
    // (first shape, in a per-headline order, that covers the margin strip without ballooning over the photo)
    const order = (['peace', 'harmony', 'x'] as BloomShape[]).sort(() => ctx.rnd() - 0.5);
    const lw = W * (square ? 0.42 : 0.5);
    const strip: [number, number][] = [
      [1, photoTop + 2],
      [F.x0 + 2, photoTop + 2],
      [1, cardBottom + W * 0.02],
      [F.x0 * 0.6, cardBottom],
    ];
    let left: BloomLayer | null = null;
    for (const lShape of order) {
      const cand = bloomLayer(ctx, lShape, pal.bg, -lw * 0.55, cardBottom - (lw / bloomAspect(lShape, ctx.m)) * 0.7, lw, {
        flipX: lShape === 'harmony',
      });
      ctx.counts.bloom--;
      growToCover(cand, strip, 0.5, 0.3);
      if (!left || cand.width < left.width) left = cand;
      if (cand.width <= W * 0.75) break;
    }
    ctx.counts.bloom = (ctx.counts.bloom ?? 0) + 1;
    left!.id = `bloom-${ctx.counts.bloom}`;
    push(ctx, left!);

    // tags under the logo (refs 13, 15)
    if (s.tags) {
      // compact strip under the logo (refs 13/15 use the minimum size here)
      const tm = tagsMetrics(ctx, 2, ctx.minFont);
      logoY = cardBottom + W * 0.035;
      tags = tagsLayer(ctx, F.x1 - tm.w, logoY + logoH + W * 0.016, 2, textOn(pal.bg), ctx.minFont);
      logoX = F.x1 - Math.max(logoW, tm.w) + (Math.max(logoW, tm.w) - logoW) / 2;
    }
    // right bloom carrying the logo (+tags): harmony's round body hangs below the card's right half (refs 06/08/11/12)
    const rx0 = Math.min(logoX, tags ? tags.x : logoX) - W * 0.04;
    const contentBottom = tags ? tags.y + tags.height : logoY + logoH;
    const rShape: BloomShape = 'harmony';
    const a = bloomAspect(rShape, ctx.m);
    // body centre sits on the card's bottom edge, right of centre, so the bulge reads like refs 06/08/11/12/13
    const lowerHalf = Math.max(H * (square ? 0.12 : 0.14), contentBottom - cardBottom + W * 0.075);
    const bh = lowerHalf / 0.32;
    const bw = bh * a;
    const right = bloomLayer(ctx, rShape, pal.bg, W * 0.9 - 0.47 * bw, cardBottom - 0.68 * bh, bw);
    growToCover(
      right,
      [
        ...samplePoints({ x: rx0, y: logoY - W * 0.02, width: W - W * 0.01 - rx0, height: contentBottom - logoY + W * 0.045 }, 6, 3, 0),
        [W - 1, photoTop + 2],
        [F.x1 + 2, photoTop + 2],
      ],
      0.47,
      0.68,
    );
    push(ctx, right);
  } else if (kind === 'device' || kind === 'illustration') {
    const info =
      kind === 'device' ? deviceInfo(ctx.s.hero.deviceId!, ctx.m) : illusInfo(ctx.s.hero.illustrationId!, ctx.m);
    const narrow = info.aspect < 0.85;
    const maxH = H - cardBottom + W * 0.02;
    let dw = kind === 'illustration' ? W * 0.8 : heroWidth(W, info.aspect) * (narrow ? 1.18 : 1.05);
    let dh = dw / info.aspect;
    const bleed = kind === 'device' ? (narrow ? 0.3 : 0.1) : -0.04;
    if (dh * (1 - bleed) > maxH) {
      dh = maxH / (1 - bleed);
      dw = dh * info.aspect;
    }
    const dcx = narrow ? W * 0.36 : W * 0.5;
    const box = { x: dcx - dw / 2, y: Math.max(cardBottom - W * 0.02, H - dh * (1 - bleed)), width: dw, height: dh };
    // accent bloom behind the hero (depth)
    const bShape = photoMask(ctx);
    const bw = Math.max(dw * 1.25, W * 0.8);
    const back = bloomLayer(ctx, bShape, pal.accent, dcx - bw * 0.48, box.y + dh * 0.12, bw, { flipX: ctx.rnd() < 0.5 });
    growToCover(back, [[dcx, H - 2], [dcx + dw * 0.3, H - 2]], 0.5, 0);
    push(ctx, back);
    if (!narrow && kind === 'device') logoY = cardBottom + W * 0.045;
    push(ctx, imageLayer(ctx, kind, info.src, info.id, box));
    if (!narrow) {
      // wide hero: logo goes bottom-left on the colour field if the hero leaves room, else beside the card
      logoX = F.x1 - logoW;
    }
  } else {
    // no hero: big blooms bleeding off the edges + charm cluster (refs 01, 05a)
    const shape = ctx.s.bloom ?? pick(ctx, ['peace', 'harmony', 'balance', 'x'] as BloomShape[]);
    const bw = W * 1.25;
    const top = bloomLayer(ctx, shape, pal.accent, -W * 0.45, cy - bw / bloomAspect(shape, ctx.m) * 0.62, bw, {
      flipX: ctx.rnd() < 0.5,
    });
    push(ctx, top);
    const s2 = pick(ctx, ['harmony', 'peace', 'energy'] as BloomShape[]);
    const bw2 = W * 0.85;
    const low = bloomLayer(ctx, s2, pal.accent, W * 0.45, cardBottom - bw2 / bloomAspect(s2, ctx.m) * 0.55, bw2, {
      flipY: ctx.rnd() < 0.5,
    });
    push(ctx, low);
    logoX = F.x0;
    logoY = F.y1 - (W * 0.26) / ctx.logoA;
  }

  // card + text
  push(ctx, rectLayer(ctx, 'card', cardBox, 'white', radius));
  push(ctx, hl);
  if (sub) push(ctx, sub);
  const cta = push(ctx, ctaLayer(ctx, cardX + px, ctaY, ctaStyle, innerW));
  if (disc && discOnRow) {
    push(
      ctx,
      bodyLayer(ctx, 'disclaimer', disc, {
        x: cardX + cardW - px - discW - 2,
        y: ctaY + (ctaM.h - discSize * 1.25) / 2,
        width: discW + 2,
        size: discSize,
        maxLines: 1,
        align: 'right',
        fill: 'navy',
        lineHeight: 1.25,
      }),
    );
  } else if (discLayer) push(ctx, discLayer);

  // stat card on the photo
  if (stat && kind !== 'none') {
    const { w: sw, h: sh } = statSize(ctx, stat);
    const right = stat.variant !== 'check';
    const low = Math.min(F.y1 - sh, H * 0.9 - sh);
    const busyBoxes: Box[] = [
      { x: logoX, y: logoY, width: logoW, height: logoH },
      ...(tags ? [tags as Box] : []),
      cardBox,
    ];
    const L = { x: F.x0 + W * 0.02, width: sw, height: sh };
    const R = { x: F.x1 - sw - W * 0.02, width: sw, height: sh };
    const cands: Box[] = story
      ? [{ ...L, y: Math.min(F.y1 - sh, Math.max(cardBottom + W * 0.2, H * 0.5)) }, { ...L, y: F.y1 - sh }]
      : right
        ? [{ ...R, y: Math.max(low, logoY + logoH + W * 0.06) }, { ...R, y: low }, { ...L, y: low }]
        : [{ ...L, y: low }, { ...R, y: low }];
    const b = firstFree(cands.filter((c) => c.y + c.height <= F.y1 + 0.5), busyBoxes) ?? cands[cands.length - 1];
    statL = push(ctx, statLayer(ctx, stat, b.x, b.y));
  }

  // logo (+tags) — coloured from what is really under it
  if (kind === 'none') {
    const lw = W * 0.26;
    const logo = logoLayer(ctx, F.x0, F.y1 - lw / ctx.logoA, lw);
    if (s.tags) {
      const tm = tagsMetrics(ctx, 2, W * 0.029);
      tags = tagsLayer(ctx, logo.x + lw + W * 0.05, logo.y + logo.height / 2 - tm.h / 2, 2, textOn(pal.bg));
    }
    if (disc && discOutside) {
      const dw = Math.min(W * 0.4, F.x1 - (logo.x + lw + W * 0.05));
      const d = bodyLayer(ctx, 'disclaimer', disc, {
        x: F.x1 - dw,
        y: 0,
        width: dw,
        size: discSize,
        maxLines: 3,
        align: 'right',
        fill: textOn(pal.bg),
        lineHeight: 1.25,
      });
      d.y = r1(F.y1 - d.height);
      push(ctx, d);
    }
    push(ctx, logo);
    if (tags) push(ctx, tags);
  } else {
    const logo = logoLayer(ctx, logoX, logoY, logoW);
    push(ctx, logo);
    if (tags) {
      tags.fill = textOn(behindBox(ctx.layers, ctx.layers.length, samplePoints(tags, 4, 2), pal.bg).colour);
      push(ctx, tags);
    }
  }

  // charms
  const avoid: Box[] = [hl, cta, ...(statL ? [statL] : []), ...ctx.layers.filter((l) => l.kind === 'logo' || l.kind === 'tags')];
  charms.forEach((c, i) => {
    const size = W * (i === 0 ? (kind === 'none' ? 0.24 : 0.13) : 0.12);
    let cands: [number, number][];
    if (kind === 'none') {
      cands =
        i === 0
          ? [
              [cardX + cardW - W * 0.1, cy - W * 0.02],
              [cardX + cardW - W * 0.06, cardBottom - W * 0.02],
            ]
          : [
              [cardX + cardW - W * 0.04, cardBottom - W * 0.04],
              [cardX + W * 0.02, cy],
            ];
    } else {
      const below = cardBottom + (H - cardBottom) * (story ? 0.25 : 0.3);
      cands =
        i === 0
          ? [
              [W * 0.2, below],
              [W * 0.25, cardBottom + W * 0.08],
              [W * 0.12, below + W * 0.1],
            ]
          : [
              statL ? [statL.x + statL.width - W * 0.01, statL.y - W * 0.01] : [W * 0.8, H * 0.82],
              [W * 0.82, below + W * 0.25],
              [W * 0.5, below + W * 0.2],
            ];
    }
    charmLayers.push(placeCharm(ctx, c, cands, size, i === 1 && statL ? avoid.filter((a) => a !== statL) : avoid, rot(ctx)));
  });
  charmLayers.forEach((c) => push(ctx, c));
}

// ---------------------------------------------------------------------------------------------
// Hero block shared by bold + offer: photo-in-bloom / device / illustration bleeding bottom-right.

function heroBlock(
  ctx: Ctx,
  heroTop: number,
  heroLeft: number,
  backColour: CoreColour | 'white',
  avoid: Box[] = [],
  textAvoid: Box[] = [],
): Box {
  const { W, H, square } = ctx;
  const kind = heroKind(ctx);
  const textPts = textAvoid.flatMap((b) => samplePoints({ x: b.x - W * 0.015, y: b.y - W * 0.015, width: b.width + W * 0.03, height: b.height + W * 0.03 }, 6, 3, 0));
  const avoidPts = avoid.flatMap((b) => samplePoints({ x: b.x - W * 0.02, y: b.y - W * 0.02, width: b.width + W * 0.04, height: b.height + W * 0.04 }, 5, 3, 0));
  const avoidTop = Math.min(H, ...avoid.filter((b) => b.y > heroTop).map((b) => b.y));
  if (kind === 'photo') {
    const mask = photoMask(ctx);
    const a = bloomAspect(mask, ctx.m);
    const ext = solidExtent(mask);
    let w = W * (square ? 0.95 : 1.05);
    let h = w / a;
    const needH = (H - heroTop) / (1 - ext.y0) + W * 0.06;
    if (h < needH) {
      h = needH;
      w = h * a;
    }
    const photo = photoLayer(ctx, { x: heroLeft - ext.x0 * w, y: heroTop - ext.y0 * h, width: w, height: h }, mask);
    photo.focusX = 0.85;
    photo.focusY = 0.4;
    const cover: [number, number][] = [[W - 2, H - 2], [W - 2, heroTop + (H - heroTop) * 0.45], [heroLeft + (W - heroLeft) * 0.45, H - 2]];
    for (let k = 0; k < 24; k++) {
      growToCover(photo, cover, ext.x0, ext.y0);
      if (avoidPts.some(([x, y]) => surfaceAt(photo, x, y))) photo.x = r1(photo.x + W * 0.035);
      else if (textPts.some(([x, y]) => surfaceAt(photo, x, y))) photo.y = r1(photo.y + W * 0.03);
      else break;
    }
    // depth bloom peeking out behind the photo (top-right)
    const bShape = pick(ctx, PHOTO_MASKS.filter((p) => p !== mask));
    const bw = photo.width * 0.62;
    const back = bloomLayer(ctx, bShape, backColour as BloomLayer['colour'], photo.x + photo.width * 0.45, heroTop - W * 0.05, bw, { flipX: ctx.rnd() < 0.5 });
    push(ctx, back);
    push(ctx, photo);
    return { x: Math.max(heroLeft, photo.x + ext.x0 * photo.width), y: heroTop, width: W - heroLeft, height: H - heroTop };
  }
  if (kind === 'device' || kind === 'illustration') {
    const info =
      kind === 'device' ? deviceInfo(ctx.s.hero.deviceId!, ctx.m) : illusInfo(ctx.s.hero.illustrationId!, ctx.m);
    const narrow = info.aspect < 0.85;
    const bottom = kind === 'illustration' ? avoidTop - W * 0.03 : H;
    const availH = bottom - heroTop;
    let dw = kind === 'illustration' ? W * 0.82 : heroWidth(W, info.aspect) * (narrow ? 1.45 : 1.2);
    let dh = dw / info.aspect;
    // phones-in-hand: the arm may bleed well off the bottom (the phone sits in the top half of the image)
    const bleed = kind === 'device' ? (narrow ? 0.4 : 0.08) : 0;
    if (dh * (1 - bleed) > availH) {
      dh = availH / (1 - bleed);
      dw = dh * info.aspect;
    }
    const cx = kind === 'illustration' ? W * 0.5 : narrow ? heroLeft + (W - heroLeft) * 0.42 : W - dw * 0.46;
    const box = { x: cx - dw / 2, y: Math.max(heroTop - W * 0.02, H - dh * (1 - bleed)), width: dw, height: dh };
    if (kind === 'illustration') box.y = heroTop + (availH - dh) * 0.45;
    for (let k = 0; k < 10 && kind === 'device'; k++) {
      if (!avoid.some((b) => overlaps(shrink(box, 0.1), b))) break;
      if (k < 4) box.x += W * 0.03;
      else {
        // shrink around the bottom-right corner
        const nw = box.width * 0.92;
        const nh = box.height * 0.92;
        box.x += box.width - nw;
        box.y += (box.height - nh) * 0.5;
        box.width = nw;
        box.height = nh;
      }
    }
    dw = box.width;
    dh = box.height;
    const bShape = photoMask(ctx);
    const bw = Math.max(dw * 1.2, W * 0.85);
    const bcx = box.x + dw / 2;
    const back = bloomLayer(ctx, bShape, backColour as BloomLayer['colour'], bcx - bw * 0.42, box.y + dh * 0.05, bw, {
      flipX: ctx.rnd() < 0.5,
    });
    growToCover(back, [[Math.min(W - 2, bcx + dw * 0.2), H - 2]], 0.4, 0);
    push(ctx, back);
    push(ctx, imageLayer(ctx, kind, info.src, info.id, box));
    return box;
  }
  // none: big bloom + charm cluster area
  const shape = ctx.s.bloom ?? pick(ctx, PHOTO_MASKS);
  const bw = W * 1.0;
  const b = bloomLayer(ctx, shape, backColour as BloomLayer['colour'], heroLeft, heroTop, bw, { flipX: ctx.rnd() < 0.5 });
  growToCover(b, [[W - 2, H - 2]], 0, 0);
  for (let k = 0; k < 10 && avoidPts.some(([x, y]) => surfaceAt(b, x, y)); k++) b.x = r1(b.x + W * 0.04);
  push(ctx, b);
  return { x: heroLeft, y: heroTop, width: W - heroLeft, height: H - heroTop };
}

function heroCharms(ctx: Ctx, hero: Box, avoid: Box[], defaults: CharmSpec[]) {
  const { W, H } = ctx;
  const specs = charmSpecs(ctx, defaults);
  const hx0 = Math.max(hero.x, W * 0.2);
  const hy0 = hero.y;
  const hw = W - hx0;
  const hh = H - hy0;
  const sizes = [0.14, 0.11, 0.12];
  const cands: [number, number][][] = [
    [
      [hx0 + hw * 0.82, hy0 + hh * 0.06],
      [hx0 + hw * 0.6, hy0 - W * 0.02],
      [hx0 + hw * 0.9, hy0 + hh * 0.3],
    ],
    [
      [hx0 - W * 0.01, hy0 + hh * 0.5],
      [hx0 + W * 0.04, hy0 + hh * 0.2],
      [hx0 + W * 0.02, hy0 + hh * 0.7],
    ],
    [
      [hx0 + hw * 0.86, hy0 + hh * 0.82],
      [hx0 + hw * 0.3, hy0 + hh * 0.05],
      [hx0 + hw * 0.5, hy0 + hh * 0.9],
    ],
  ];
  const placed: CharmLayer[] = [];
  specs.slice(0, 3).forEach((c, i) => {
    const l = placeCharm(ctx, c, cands[i], W * sizes[i], [...avoid, ...placed], rot(ctx));
    placed.push(l);
  });
  placed.forEach((p) => push(ctx, p));
}

// ---------------------------------------------------------------------------------------------
// Template: bold (dark | blue | light) — refs 02, 04, 07, 10

function bold(ctx: Ctx) {
  const { W, H, F, s, story, square, pal } = ctx;
  const kind = heroKind(ctx);
  const centred = kind === 'illustration';
  const logoW = W * 0.26;
  const logoH = logoW / ctx.logoA;
  let y = F.y0;
  if (story) y += logoH + W * 0.06; // story: logo sits at the top of the safe zone
  const hl = headlineLayer(ctx, s.headline, {
    x: F.x0,
    y,
    width: F.x1 - F.x0,
    base: W * (square ? 0.118 : 0.132),
    maxLines: story ? 4 : 3,
    preferLines: 2,
    preferMinScale: 0.76,
    align: centred ? 'center' : 'left',
    fill: pal.text,
  });
  let yy = hl.y + hl.height;
  let sub: TextLayer | null = null;
  if (s.sub) {
    sub = bodyLayer(ctx, 'sub', s.sub, {
      x: F.x0,
      y: yy + W * 0.03,
      width: (F.x1 - F.x0) * (centred ? 1 : 0.9),
      size: W * 0.034,
      maxLines: 3,
      fill: pal.text,
      align: centred ? 'center' : 'left',
    });
    yy = sub.y + sub.height;
  }
  const ctaStyle = ctaStyleOn(ctx, pal.bg);
  const ctaM = ctaMetrics(ctx, s.cta, F.x1 - F.x0);
  const ctaBottomRow = centred && !story;
  const ctaY = ctaBottomRow ? F.y1 - Math.max(ctaM.h, logoH) / 2 - ctaM.h / 2 : yy + W * 0.055;
  const disc = disclaimerText(ctx);
  let discL: TextLayer | null = null;
  if (disc) {
    discL = bodyLayer(ctx, 'disclaimer', disc, {
      x: F.x0,
      y: ctaBottomRow ? 0 : ctaY + ctaM.h + W * 0.02,
      width: (F.x1 - F.x0) * 0.6,
      size: Math.max(ctx.minFont, W * 0.026),
      maxLines: 2,
      fill: pal.text,
      lineHeight: 1.25,
    });
    if (ctaBottomRow) discL.y = r1(ctaY - discL.height - W * 0.02);
  }
  const textBottom = ctaBottomRow ? yy : discL && !ctaBottomRow ? discL.y + discL.height : ctaY + ctaM.h;
  const heroTop = Math.max(textBottom + W * (kind === 'illustration' ? 0.04 : 0.05), story && kind !== 'illustration' ? H * 0.5 : 0);

  // accent field for illustrations (ref 02: blue bloom filling the lower half)
  if (kind === 'illustration') {
    const bgId = story ? 'bg_12' : 'bg_10';
    const a = bgAspect(bgId, ctx.m);
    const topFrac = story ? 0.42 : 0.44;
    const want = heroTop + (H - heroTop) * 0.3;
    let h = Math.max(H, (H - want) / (1 - topFrac) * 1.03);
    let w = h * a;
    if (w < W) {
      w = W * 1.02;
      h = w / a;
    }
    const box = { x: (W - w) / 2, y: story ? H - h : want - topFrac * h, width: w, height: h };
    push(ctx, bgShapeLayer(ctx, bgId, pal.accent, box, { flipY: story }));
  }
  const heroLeft = kind === 'illustration' ? 0 : W * (square ? 0.36 : 0.3);
  const logoBox: Box = story
    ? { x: F.x0, y: F.y0, width: logoW, height: logoH }
    : centred
      ? { x: F.x1 - logoW, y: F.y1 - logoH, width: logoW, height: logoH }
      : { x: F.x0, y: F.y1 - logoH, width: logoW, height: logoH };
  const avoid: Box[] = [logoBox];
  if (ctaBottomRow) avoid.push({ x: F.x0, y: ctaY, width: ctaM.w, height: ctaM.h });
  if (s.tags && !story) avoid.push({ x: F.x0, y: logoBox.y - W * 0.12, width: W * 0.42, height: W * 0.1 });
  const textAvoid: Box[] = [...lineBoxes(hl), ...(sub ? lineBoxes(sub) : []), { x: F.x0, y: ctaY, width: ctaM.w, height: ctaM.h }];
  const hero =
    kind === 'illustration'
      ? heroBlock(ctx, heroTop, heroLeft, pal.accent === 'sky' ? 'navy' : pal.accent, avoid, textAvoid)
      : heroBlock(ctx, heroTop, heroLeft, pal.back, avoid, textAvoid);

  push(ctx, hl);
  if (sub) push(ctx, sub);
  const cta = push(ctx, ctaLayer(ctx, F.x0, ctaY, ctaStyle, F.x1 - F.x0));
  if (discL) push(ctx, discL);

  let statL: StatLayer | null = null;
  if (s.stat) {
    const { w: sw, h: sh } = statSize(ctx, s.stat);
    const sx = Math.max(F.x0, hero.x - sw * 0.45);
    const sy = Math.max(hero.y, Math.min(F.y1 - sh - (story ? 0 : logoH + W * 0.06), hero.y + (H - hero.y) * 0.16));
    const tmS = tagsMetrics(ctx, 2, W * 0.026);
    const busyBoxes: Box[] = [logoBox, ...textAvoid];
    if (s.tags && !story) busyBoxes.push({ x: logoBox.x, y: logoBox.y - tmS.h - W * 0.03, width: tmS.w, height: tmS.h });
    const cands: Box[] = [
      { x: sx, y: sy, width: sw, height: sh },
      { x: F.x1 - sw, y: sy, width: sw, height: sh },
      { x: F.x1 - sw, y: Math.max(hero.y, F.y1 - sh), width: sw, height: sh },
    ];
    const b = firstFree(cands, busyBoxes) ?? cands[0];
    statL = push(ctx, statLayer(ctx, s.stat, b.x, b.y));
  }
  const logo = story
    ? logoLayer(ctx, F.x0, F.y0, logoW)
    : centred
      ? logoLayer(ctx, F.x1 - logoW, F.y1 - logoH, logoW)
      : logoLayer(ctx, F.x0, F.y1 - logoH, logoW);
  push(ctx, logo);
  let tags: TagsLayer | null = null;
  if (s.tags && !story) {
    const tm = tagsMetrics(ctx, 2, W * 0.026);
    tags = tagsLayer(ctx, logo.x, logo.y - tm.h - W * 0.03, 2, pal.text, W * 0.026);
    tags.fill = textOn(behindBox(ctx.layers, ctx.layers.length, samplePoints(tags, 4, 2), pal.bg).colour);
    push(ctx, tags);
  }
  heroCharms(ctx, hero, [hl, cta, logo, ...(statL ? [statL] : []), ...(tags ? [tags] : []), ...(sub ? [sub] : [])], [
    { charm: 'sparkle', colour: 'yellow' },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Template: offer (light) — refs 16, 18, 19

function offer(ctx: Ctx) {
  const { W, H, F, s, story, square, pal } = ctx;
  const logoW = W * 0.26;
  const logoH = logoW / ctx.logoA;
  let y = F.y0;
  if (story) y += logoH + W * 0.06;
  const hl = headlineLayer(ctx, s.headline, {
    x: F.x0,
    y,
    width: F.x1 - F.x0,
    base: W * (square ? 0.115 : 0.13),
    maxLines: story ? 4 : 3,
    preferLines: 2,
    preferMinScale: 0.76,
    fill: 'navy',
  });
  let yy = hl.y + hl.height;
  let sub: TextLayer | null = null;
  if (s.sub) {
    sub = bodyLayer(ctx, 'sub', s.sub, { x: F.x0, y: yy + W * 0.035, width: (F.x1 - F.x0) * 0.94, size: W * 0.034, maxLines: 3, fill: 'navy' });
    yy = sub.y + sub.height;
  }
  const ctaY = yy + W * 0.05;
  const ctaM = ctaMetrics(ctx, s.cta, F.x1 - F.x0);
  const disc = disclaimerText(ctx);
  const discSize = Math.max(ctx.minFont, W * 0.026);
  const discInSub = !!disc && !!s.sub && s.sub.toLowerCase().includes(disc.toLowerCase().replace(/[.*]/g, '').trim());
  let discL: TextLayer | null = null;
  if (disc && !discInSub) {
    discL = bodyLayer(ctx, 'disclaimer', disc, {
      x: F.x0,
      y: ctaY + ctaM.h + W * 0.03,
      width: (F.x1 - F.x0) * 0.55,
      size: discSize,
      maxLines: 2,
      fill: 'navy',
      lineHeight: 1.25,
    });
  }
  const textBottom = discL ? discL.y + discL.height : ctaY + ctaM.h;
  const heroTop = Math.max(textBottom + W * 0.04, story ? H * 0.5 : 0);
  const heroLeft = W * (square ? 0.38 : 0.34);
  const oAvoid: Box[] = story ? [] : [{ x: F.x0, y: F.y1 - logoH, width: logoW, height: logoH }];
  if (s.tags && !story) {
    const tmA = tagsMetrics(ctx, 1, W * 0.027);
    oAvoid.push({ x: F.x0, y: F.y1 - logoH - tmA.h - W * 0.035, width: tmA.w, height: tmA.h });
  }
  const oText: Box[] = [
    ...lineBoxes(hl),
    ...(sub ? lineBoxes(sub) : []),
    { x: F.x0, y: ctaY, width: ctaM.w, height: ctaM.h },
    ...(discL ? lineBoxes(discL) : []),
  ];
  const hero = heroBlock(ctx, heroTop, heroLeft, 'white', oAvoid, oText);

  push(ctx, hl);
  if (sub) push(ctx, sub);
  const cta = push(ctx, ctaLayer(ctx, F.x0, ctaY, ctaStyleOn(ctx, 'sky', 'navy'), F.x1 - F.x0));
  if (discL) push(ctx, discL);

  let statL: StatLayer | null = null;
  if (s.stat) {
    const { w: sw, h: sh } = statSize(ctx, s.stat);
    const sx = story ? F.x1 - sw : F.x1 - sw + W * 0.01;
    const sy = story ? Math.min(F.y1 - sh, hero.y + W * 0.25) : Math.min(F.y1 - sh, H * 0.86 - sh);
    statL = push(ctx, statLayer(ctx, s.stat, Math.min(sx, F.x1 - sw), Math.max(sy, hero.y)));
  }
  const logo = story ? logoLayer(ctx, F.x0, F.y0, logoW) : logoLayer(ctx, F.x0, F.y1 - logoH, logoW);
  push(ctx, logo);
  let tags: TagsLayer | null = null;
  const tmO = tagsMetrics(ctx, 1, W * 0.027);
  const tyO = story ? Math.max(heroTop, F.y1 - tmO.h) : logo.y - tmO.h - W * 0.035;
  if (s.tags && tyO + tmO.h <= F.y1 + 0.5) {
    const ty = tyO;
    tags = tagsLayer(ctx, F.x0, ty, 1, 'navy', W * 0.027);
    tags.fill = textOn(behindBox(ctx.layers, ctx.layers.length, samplePoints(tags, 2, 4), pal.bg).colour);
    push(ctx, tags);
  }
  heroCharms(ctx, hero, [hl, cta, logo, ...(statL ? [statL] : []), ...(tags ? [tags] : []), ...(sub ? [sub] : []), ...(discL ? [discL] : [])], [
    { charm: 'sparkle', colour: 'yellow' },
    { charm: 'coin', colour: 'yellow' },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Template: checklist (dark | blue) — refs 03, 09

function checklist(ctx: Ctx) {
  const { W, H, F, s, story, square, pal } = ctx;
  const items = s.items?.length ? s.items : ['Invoices sent', 'Payments in', 'Me time'];
  const logoW = W * 0.27;
  const logoH = logoW / ctx.logoA;
  const hl = headlineLayer(ctx, s.headline, {
    x: F.x0,
    y: F.y0 + W * 0.005,
    width: F.x1 - F.x0,
    base: W * (square ? 0.104 : 0.115),
    maxLines: story ? 4 : 3,
    preferLines: 2,
    align: 'center',
    fill: pal.text,
  });
  // bottom row: CTA left, logo right
  const ctaM = ctaMetrics(ctx, s.cta, (F.x1 - F.x0) * 0.6);
  const rowH = Math.max(ctaM.h, logoH);
  const bottomY = F.y1 - rowH;
  let tags: TagsLayer | null = null;
  let tagsTop = bottomY;
  if (s.tags) {
    const tm = tagsMetrics(ctx, 4, W * 0.026);
    const fsT = tm.w > F.x1 - F.x0 ? W * 0.026 * ((F.x1 - F.x0) / tm.w) : W * 0.026;
    const tm2 = tagsMetrics(ctx, 4, fsT);
    tagsTop = bottomY - tm2.h - W * 0.045;
    tags = tagsLayer(ctx, F.x0 + (F.x1 - F.x0 - tm2.w) / 2, tagsTop, 4, 'white', fsT);
  }
  // rows
  const rowW = W * (square ? 0.72 : 0.75);
  const rowX = (W - rowW) / 2 - W * 0.02;
  const gap = W * (square ? 0.022 : 0.028);
  const rowsRoom = tagsTop - W * 0.06 - (F.y0 + W * 0.005 + hl.height + W * 0.06);
  const rH = Math.max(W * 0.065, Math.min(W * (square ? 0.12 : 0.148), (rowsRoom - (items.length - 1) * gap) / items.length));
  const iconS = rH * 0.7;
  const textX = rowX + rH * 0.22 + iconS + W * 0.035;
  const textW = rowX + rowW - W * 0.05 - textX;
  // shared row font size: the longest item on one line, else two lines
  let fs = rH * 0.58;
  const longest = items.reduce((a, b) => (measureText(b, 'headline', 700, fs, 0) > measureText(a, 'headline', 700, fs, 0) ? b : a), items[0]);
  while (measureText(longest, 'headline', 700, fs, -0.005 * fs) > textW && fs > rH * 0.36) fs *= 0.96;
  const twoLines = measureText(longest, 'headline', 700, fs, -0.005 * fs) > textW;
  const rowHeight = twoLines ? rH * 1.35 : rH;
  const blockH = items.length * rowHeight + (items.length - 1) * gap;
  const top = hl.y + hl.height + W * 0.06;
  const bottom = tagsTop - W * 0.06;
  const rowsTop = Math.min(top + Math.max(0, (bottom - top - blockH) * 0.4), Math.max(hl.y + hl.height + W * 0.02, bottom - blockH));

  // big accent shape covering the lower part (dome under the rows)
  const bgId = story ? 'bg_12' : 'bg_10';
  const a = bgAspect(bgId, ctx.m);
  const topFrac = story ? 0.42 : 0.44;
  const want = rowsTop + rowHeight * 0.4;
  let bh = Math.max(H * 0.8, ((H - want) / (1 - topFrac)) * 1.03);
  let bw = bh * a;
  if (bw < W * 1.1) {
    bw = W * 1.1;
    bh = bw / a;
  }
  push(
    ctx,
    bgShapeLayer(ctx, bgId, pal.accent === 'sky' ? 'navy' : pal.accent, { x: (W - bw) / 2 - W * 0.05, y: story ? H - bh : want - topFrac * bh, width: bw, height: bh }, { flipY: story }),
  );
  push(ctx, hl);
  items.forEach((it, i) => {
    const ry = rowsTop + i * (rowHeight + gap);
    push(ctx, rectLayer(ctx, 'row', { x: rowX, y: ry, width: rowW, height: rowHeight }, 'white', rowHeight / 2));
    push(ctx, charmLayer(ctx, { charm: 'check', colour: 'green' }, rowX + rH * 0.22 + iconS / 2, ry + rowHeight / 2, iconS, 0, 'decor'));
    const t = bodyLayer(ctx, 'row-text', it, {
      x: textX,
      y: 0,
      width: textW,
      size: fs,
      weight: 700,
      maxLines: 2,
      fill: 'navy',
      font: 'headline',
      lineHeight: 1.0,
    });
    t.y = r1(ry + (rowHeight - t.height) / 2);
    push(ctx, t);
  });
  if (tags) {
    tags.fill = textOn(behindBox(ctx.layers, ctx.layers.length, samplePoints(tags, 6, 2), pal.bg).colour);
    push(ctx, tags);
  }
  const cta = push(ctx, ctaLayer(ctx, F.x0, bottomY + (rowH - ctaM.h) / 2, ctaStyleOn(ctx, pal.bg), (F.x1 - F.x0) * 0.6));
  const logo = push(ctx, logoLayer(ctx, F.x1 - logoW, bottomY + (rowH - logoH) / 2, logoW));
  // charms: sparkle near the first row's top-left, second on the last row's right end
  const specs = charmSpecs(ctx, [
    { charm: 'sparkle', colour: 'yellow' },
    { charm: 'mug', colour: 'purple' },
  ]);
  const lastY = rowsTop + (items.length - 1) * (rowHeight + gap);
  const cands: [number, number][][] = [
    [
      [rowX - W * 0.01, rowsTop - W * 0.05],
      [rowX + rowW, rowsTop - W * 0.04],
      [rowX - W * 0.005, rowsTop + W * 0.01],
    ],
    [
      [rowX + rowW - W * 0.03, lastY + rowHeight * 0.75],
      [rowX + rowW + W * 0.02, rowsTop - W * 0.04],
    ],
    [[W * 0.86, rowsTop + blockH * 0.5]],
  ];
  const avoid: Box[] = [...lineBoxes(hl), cta, logo, ...(tags ? [tags] : [])];
  specs.slice(0, 3).forEach((c, i) => push(ctx, placeCharm(ctx, c, cands[i], W * (i === 1 ? 0.17 : 0.11), avoid, rot(ctx))));
}

// ---------------------------------------------------------------------------------------------
// Template: split (sky + navy two-tone) — ref 14

function split(ctx: Ctx) {
  const { W, H, F, s, story, square } = ctx;
  const colW = W * 0.43;
  const hl = headlineLayer(ctx, s.headline, {
    x: F.x0,
    y: F.y0,
    width: colW,
    base: W * (square ? 0.08 : 0.088),
    maxLines: story ? 5 : 4,
    fill: 'white',
  });
  const h2text = s.headline2 ?? 'Xero has your back.';
  const x2 = W * 0.52;
  const hl2 = headlineLayer(ctx, h2text, {
    x: x2,
    y: F.y0,
    width: F.x1 - x2,
    base: W * (square ? 0.08 : 0.088),
    maxLines: story ? 4 : 3,
    align: 'right',
    fill: 'navy',
    role: 'headline2',
  });
  const logoW = W * 0.25;
  const logoH = logoW / ctx.logoA;
  const ctaM = ctaMetrics(ctx, s.cta, W * 0.4);
  const rowH = Math.max(logoH, ctaM.h);
  const bottomY = F.y1 - rowH;

  // navy diagonal field (bg_15 mirrored): search a box where every white headline line sits on navy and
  // headline2 / tags / logo / CTA stay on sky.
  const bgId = 'bg_15';
  const a = bgAspect(bgId, ctx.m);
  const onNavy = lineSamples(hl, W * 0.025);
  const onSky = [
    ...lineSamples(hl2, W * 0.025),
    ...samplePoints({ x: F.x0, y: bottomY - W * 0.3, width: W * 0.34, height: W * 0.3 + rowH }, 4, 4, 0),
    ...samplePoints({ x: F.x1 - W * 0.4, y: bottomY, width: W * 0.4, height: rowH }, 4, 2, 0),
  ];
  const want = [
    [W * 0.01, Math.min(H * 0.5, hl.y + hl.height + W * 0.12)],
    [W * 0.3, W * 0.01],
  ] as [number, number][];
  let best: Box | null = null;
  outer: for (let k = 0; k <= 14; k++) {
    const w = W * (1.0 + k * 0.1);
    const h = w / a;
    for (const xo of [-0.3, -0.38, -0.22, -0.46, -0.14]) {
      for (let yi = 0; yi <= 10; yi++) {
        const box = { x: w * xo, y: -h * (0.05 + yi * 0.04), width: w, height: h };
        const probe = bgShapeLayer(ctx, bgId, 'navy', box, { flipX: true });
        ctx.counts['bg-shape']--;
        const hit = ([x, y]: [number, number]) => !!surfaceAt(probe, x, y);
        if (onNavy.every(hit) && want.every(hit) && !onSky.some(hit)) {
          best = box;
          break outer;
        }
      }
    }
  }
  best ??= { x: -W * 0.4, y: -H * 0.25, width: W * 1.2, height: (W * 1.2) / a };
  push(ctx, bgShapeLayer(ctx, bgId, 'navy', best, { flipX: true }));

  // device (phone in hand) centre-right, bleeding off the bottom
  const kind = heroKind(ctx);
  const heroTop = Math.max(hl2.y + hl2.height + W * 0.06, H * (story ? 0.36 : 0.3));
  let heroBox: Box = { x: W * 0.35, y: heroTop, width: W * 0.6, height: H - heroTop };
  if (kind === 'device' || kind === 'illustration') {
    const info =
      kind === 'device' ? deviceInfo(s.hero.deviceId!, ctx.m) : illusInfo(s.hero.illustrationId!, ctx.m);
    const narrow = info.aspect < 0.85;
    let dw = heroWidth(W, info.aspect) * 1.05;
    let dh = dw / info.aspect;
    const avail = H - heroTop;
    if (dh * 0.94 > avail) {
      dh = avail / 0.94;
      dw = dh * info.aspect;
    }
    heroBox = { x: narrow ? W * 0.64 - dw / 2 : W - dw * 0.92, y: H - dh * 0.94, width: dw, height: dh };
    push(ctx, imageLayer(ctx, kind, info.src, info.id, heroBox));
  } else if (kind === 'photo') {
    const mask = photoMask(ctx);
    const pw = W * 0.75;
    const ph = pw / bloomAspect(mask, ctx.m);
    heroBox = { x: W * 0.3, y: Math.max(heroTop, H - ph * 0.92), width: pw, height: ph };
    const p = photoLayer(ctx, heroBox, mask);
    growToCover(p, [[W - 2, H - 2]], 0, 0);
    push(ctx, p);
  }
  push(ctx, hl);
  push(ctx, hl2);
  let tags: TagsLayer | null = null;
  if (s.tags) {
    const tm = tagsMetrics(ctx, 1, W * 0.027);
    tags = tagsLayer(ctx, F.x0, bottomY - tm.h - W * 0.045, 1, 'navy', W * 0.027);
    tags.fill = textOn(behindBox(ctx.layers, ctx.layers.length, samplePoints(tags, 2, 4), 'sky').colour);
    push(ctx, tags);
  }
  const logo = push(ctx, logoLayer(ctx, F.x0, bottomY + (rowH - logoH) / 2, logoW));
  const cta = push(ctx, ctaLayer(ctx, 0, bottomY + (rowH - ctaM.h) / 2, ctaStyleOn(ctx, 'sky', 'white'), W * 0.4));
  cta.x = r1(F.x1 - cta.width);
  const disc = disclaimerText(ctx);
  if (disc) {
    const d = bodyLayer(ctx, 'disclaimer', disc, {
      x: F.x1 - W * 0.4,
      y: 0,
      width: W * 0.4,
      size: Math.max(ctx.minFont, W * 0.026),
      maxLines: 2,
      align: 'right',
      fill: 'navy',
      lineHeight: 1.25,
    });
    d.y = r1(cta.y - d.height - W * 0.02);
    push(ctx, d);
  }
  const specs = charmSpecs(ctx, [{ charm: 'heart', colour: 'pink' }]);
  const avoid: Box[] = [hl, hl2, cta, logo, ...(tags ? [tags] : [])];
  const cands: [number, number][][] = [
    [
      [W * 0.8, heroTop + W * 0.06],
      [W * 0.84, heroTop + W * 0.2],
    ],
    [
      [heroBox.x + W * 0.02, heroBox.y + heroBox.height * 0.35],
      [W * 0.3, H * 0.6],
    ],
    [[W * 0.86, H * 0.62]],
  ];
  specs.slice(0, 3).forEach((c, i) => push(ctx, placeCharm(ctx, c, cands[i], W * (i === 0 ? 0.14 : 0.11), avoid, rot(ctx))));
}

// ---------------------------------------------------------------------------------------------

export function buildDesignImpl(slotsIn: Slots, size: Size, manifest: Manifest | null, opts: { id?: string; name?: string } = {}): Design {
  const s = normalizeSlots(slotsIn);
  const W = Math.max(100, Math.round(size?.width || 1080));
  const H = Math.max(100, Math.round(size?.height || 1350));
  const story = H / W > 1.6;
  const square = H / W < 1.12;
  const m = W * SAFE.margin;
  const F = story
    ? // stricter of "bottom 35%" and the bottom-right 21%x40% corner, so right-aligned items stay clear too
      { x0: W * SAFE.story.side, y0: H * SAFE.story.top, x1: W * (1 - SAFE.story.side), y1: H * (1 - Math.max(SAFE.story.bottom, SAFE.story.bottomRightH)) }
    : { x0: m, y0: m, x1: W - m, y1: H - m };
  const seed = hashStr(`${s.template}|${s.colourway}|${s.headline}`);
  const pal = PALETTES[s.colourway];
  const ctx: Ctx = {
    W,
    H,
    s,
    m: manifest,
    F,
    story,
    square,
    layers: [],
    counts: {},
    rnd: rng(seed),
    pal,
    logoA: logoAspect(manifest),
    minFont: (MIN_FONT_PX_AT_1080 * W) / 1080,
  };
  if (s.template === 'bold') bold(ctx);
  else if (s.template === 'checklist') checklist(ctx);
  else if (s.template === 'split') split(ctx);
  else if (s.template === 'offer') offer(ctx);
  else card(ctx);

  const background: CoreColour = s.template === 'split' ? 'sky' : pal.bg;
  return {
    id: opts.id ?? `d-${hashStr(JSON.stringify(s) + `|${W}x${H}`).toString(36)}`,
    name: opts.name ?? s.headline.slice(0, 40),
    width: W,
    height: H,
    background,
    template: s.template,
    colourway: s.colourway,
    slots: s,
    layers: ctx.layers,
  };
}
