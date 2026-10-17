// SVG -> editable Design.
//   <text>                       -> TextLayer (tspans on separate baselines -> lines joined with \n)
//   solid <rect> behind short text -> ButtonLayer (role 'cta')
//   <image> (embedded data URI)  -> ImageLayer
//   everything else              -> one movable ImageLayer rendered from the SVG minus text/images (role 'flat-image')
// The SVG is sanitized before it touches the live document, and is measured inside a shadow root so its
// <style> rules cannot leak into the editor.
import type { ButtonLayer, Design, ImageLayer, Layer } from '../types';
import type { ImportResult } from './index';
import {
  ALL_TOKENS,
  backgroundOf,
  baseName,
  buildTextLayer,
  clamp,
  DESIGN_W,
  ensureBrandFonts,
  fontNote,
  idMaker,
  ImportError,
  isBlank,
  isBrandTextColour,
  loadImage,
  makeCanvas,
  ctx2d,
  nearestToken,
  parseCssColour,
  parseWeight,
  PixelSampler,
  plural,
  pool,
  r1,
  r2,
  sleep,
  snapTextColour,
  UPLOAD_CONCURRENCY,
  uploadBlob,
  uploadCanvas,
  weightFromName,
  type RGB,
  type TextSpec,
  type Uploaded,
} from './util';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
/** Never rendered directly (content is referenced from elsewhere). */
const NON_RENDERED = new Set([
  'defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'linearGradient', 'radialGradient', 'filter',
  'metadata', 'title', 'desc', 'style',
]);
/** Elements that can run script, load documents or animate attributes: removed outright. */
const BLOCKED = new Set([
  'script', 'foreignobject', 'iframe', 'embed', 'object', 'audio', 'video', 'canvas', 'animate', 'animatemotion',
  'animatetransform', 'animatecolor', 'set', 'handler', 'listener', 'discard',
]);
const IMPORTED = 'data-import-extracted';

interface SanitizeReport {
  elements: number;
  handlers: number;
  links: number;
}

// ---------------------------------------------------------------------------------------------
// Sanitizing

function isSafeHref(el: Element, value: string): boolean {
  const v = value.trim();
  if (v.startsWith('#')) return true;
  const ln = el.localName;
  return (ln === 'image' || ln === 'feImage') && /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(v);
}

/** Strips @import, external url(...) and script-ish CSS. Fragment refs and embedded images/fonts survive. */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q: string, u: string) =>
      /^\s*(#|data:(image|font|application\/(x-)?font)[\w/.+-]*[;,])/i.test(u) ? m : 'none',
    )
    .replace(/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/gi, '');
}

/** In-place: removes script/foreignObject/animation elements, foreign-namespace elements, on* handlers and unsafe links. */
export function sanitizeSvg(root: Element): SanitizeReport {
  const rep: SanitizeReport = { elements: 0, handlers: 0, links: 0 };
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!root.contains(el)) continue; // inside something already removed
    if (el.namespaceURI !== SVG_NS || BLOCKED.has(el.localName.toLowerCase())) {
      el.remove();
      rep.elements++;
      continue;
    }
    cleanAttributes(el, rep);
    if (el.localName === 'style') el.textContent = cleanCss(el.textContent ?? '');
  }
  cleanAttributes(root, rep);
  return rep;
}

function cleanAttributes(el: Element, rep: SanitizeReport) {
  for (const attr of Array.from(el.attributes)) {
    const local = attr.localName.toLowerCase();
    const value = attr.value;
    if (local.startsWith('on')) {
      el.removeAttributeNode(attr);
      rep.handlers++;
    } else if (local === 'href') {
      if (!isSafeHref(el, value)) {
        el.removeAttributeNode(attr);
        rep.links++;
      }
    } else if (local === 'style') {
      const clean = cleanCss(value);
      if (clean !== value) attr.value = clean;
    } else if (/javascript:|vbscript:|data:text\/html/i.test(value) || /url\(\s*['"]?\s*(?!#)/i.test(value)) {
      el.removeAttributeNode(attr);
      rep.links++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

function parseLength(v: string | null): number | null {
  if (!v) return null;
  const m = v.trim().match(/^([+]?[\d.]+(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex)?$/i);
  if (!m) return null; // %, auto, garbage
  const k: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };
  const n = parseFloat(m[1]) * k[(m[2] ?? 'px').toLowerCase()];
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseViewBox(v: string | null): [number, number, number, number] | null {
  if (!v) return null;
  const p = v.trim().split(/[\s,]+/).map(Number);
  return p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0 ? (p as [number, number, number, number]) : null;
}

function nonRendered(el: Element, root: Element): boolean {
  for (let e: Element | null = el.parentElement; e && e !== root; e = e.parentElement) {
    if (NON_RENDERED.has(e.localName)) return true;
  }
  return false;
}

function hidden(el: Element, root: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
  for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) {
    if (getComputedStyle(e).display === 'none') return true;
    if (e === root) break;
  }
  return effectiveOpacity(el, root) < 0.01;
}

function effectiveOpacity(el: Element, root: Element): number {
  let o = 1;
  for (let e: Element | null = el; e; e = e.parentElement) {
    const v = parseFloat(getComputedStyle(e).opacity);
    if (Number.isFinite(v)) o *= v;
    if (e === root) break;
  }
  return o;
}

function clippedOrFiltered(el: Element, root: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if ((cs.clipPath && cs.clipPath !== 'none') || (cs.mask && cs.mask !== 'none') || (cs.filter && cs.filter !== 'none')) return true;
    if (e === root) break;
  }
  return false;
}

/** Element user space -> design pixels (the root is laid out at exactly W x H CSS px). */
interface Frame {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  sx: number;
  sy: number;
  rotation: number;
}

function frameOf(el: SVGGraphicsElement, origin: DOMRect): Frame | null {
  const m = el.getScreenCTM();
  if (!m) return null;
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  if (!sx || !sy) return null;
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e - origin.left, f: m.f - origin.top, sx, sy, rotation: (Math.atan2(m.b, m.a) * 180) / Math.PI };
}

const isRotated = (f: Frame) => Math.abs(f.rotation) > 0.5;
const apply = (f: Frame, u: number, v: number): [number, number] => [f.a * u + f.c * v + f.e, f.b * u + f.d * v + f.f];

/** Local box (user units) -> design box; rotated frames keep the box size and report the rotation. */
function designBox(f: Frame, x: number, y: number, w: number, h: number) {
  if (!isRotated(f)) {
    const [x0, y0] = apply(f, x, y);
    const [x1, y1] = apply(f, x + w, y + h);
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), rotation: 0 };
  }
  const [X, Y] = apply(f, x, y);
  return { x: X, y: Y, width: w * f.sx, height: h * f.sy, rotation: f.rotation };
}

// ---------------------------------------------------------------------------------------------
// Text

interface Run {
  el: SVGTSpanElement;
  chars: number;
  baseline: number;
  bb: DOMRect;
  cs: CSSStyleDeclaration;
  fontSize: number;
}

/** Wrap loose text nodes so every visible character sits in a leaf <tspan> (layout is unchanged). */
function wrapLooseText(t: SVGTextElement) {
  const loose: Text[] = [];
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    if (!node.data.trim()) continue;
    const p = node.parentElement;
    const leaf = p?.localName === 'tspan' && Array.from(p.childNodes).every((c) => c.nodeType === Node.TEXT_NODE);
    if (!leaf) loose.push(node);
  }
  for (const node of loose) {
    const span = document.createElementNS(SVG_NS, 'tspan') as SVGTSpanElement;
    node.parentNode?.insertBefore(span, node);
    span.appendChild(node);
  }
}

function runBox(sp: SVGTSpanElement, n: number): DOMRect {
  try {
    const bb = sp.getBBox();
    if (bb.width > 0 || bb.height > 0) return bb;
  } catch {
    /* fall through */
  }
  const a = sp.getExtentOfChar(0);
  const b = sp.getExtentOfChar(n - 1);
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return new DOMRect(x0, y0, Math.max(a.x + a.width, b.x + b.width) - x0, Math.max(a.y + a.height, b.y + b.height) - y0);
}

interface TextGeom {
  spec: TextSpec;
  /** Ink-ish box of a single-line text in design px (for CTA detection). */
  box: { x: number; y: number; width: number; height: number };
  lines: number;
  rotated: boolean;
}

function readText(t: SVGTextElement, root: SVGSVGElement, origin: DOMRect): TextGeom | null {
  wrapLooseText(t);
  const runs: Run[] = [];
  for (const sp of Array.from(t.querySelectorAll('tspan')) as SVGTSpanElement[]) {
    if (!Array.from(sp.childNodes).every((c) => c.nodeType === Node.TEXT_NODE)) continue;
    if (!(sp.textContent ?? '').trim()) continue;
    const cs = getComputedStyle(sp);
    if (cs.display === 'none' || cs.visibility !== 'visible') continue;
    const chars = sp.getNumberOfChars();
    if (!chars) continue;
    const p = sp.getStartPositionOfChar(0);
    runs.push({ el: sp, chars, baseline: p.y, bb: runBox(sp, chars), cs, fontSize: parseFloat(cs.fontSize) || 16 });
  }
  if (!runs.length) return null;

  // Group runs into lines by baseline.
  const lines: { baseline: number; runs: Run[] }[] = [];
  for (const r of runs) {
    const line = lines.find((l) => Math.abs(l.baseline - r.baseline) < r.fontSize * 0.3);
    if (line) line.runs.push(r);
    else lines.push({ baseline: r.baseline, runs: [r] });
  }
  lines.sort((a, b) => a.baseline - b.baseline);
  const lineOf = new Map<Element, number>();
  lines.forEach((l, i) => l.runs.forEach((r) => lineOf.set(r.el, i)));

  // Line strings in document order; whitespace between runs on the same line becomes one space.
  const texts = lines.map(() => '');
  let last = -1;
  let pendingSpace = false;
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = (n as Text).data;
    const li = n.parentElement ? lineOf.get(n.parentElement) : undefined;
    if (li === undefined) {
      if (/\s/.test(data)) pendingSpace = true;
      continue;
    }
    const s = data.replace(/\s+/g, ' ');
    if (li === last && pendingSpace && !texts[li].endsWith(' ') && !s.startsWith(' ')) texts[li] += ' ';
    texts[li] += s;
    last = li;
    pendingSpace = false;
  }
  const keep = texts.map((s, i) => ({ s: s.replace(/\s+/g, ' ').trim(), l: lines[i] })).filter((x) => x.s);
  if (!keep.length) return null;

  const dom = runs.reduce((a, b) => (b.chars > a.chars ? b : a));
  const frame = frameOf(t, origin);
  if (!frame) return null;
  const fontUser = dom.fontSize;
  const lefts = keep.map((k) => Math.min(...k.l.runs.map((r) => r.bb.x)));
  const rights = keep.map((k) => Math.max(...k.l.runs.map((r) => r.bb.x + r.bb.width)));
  const baselines = keep.map((k) => k.l.baseline);

  // Alignment: text-anchor, unless the line geometry clearly says otherwise (Figma exports position every line).
  const anchor = dom.cs.textAnchor === 'middle' ? 'center' : dom.cs.textAnchor === 'end' ? 'right' : 'left';
  let align: 'left' | 'center' | 'right' = anchor;
  if (keep.length > 1) {
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const tol = fontUser * 0.12;
    const s = {
      left: spread(lefts),
      center: spread(lefts.map((l, i) => (l + rights[i]) / 2)),
      right: spread(rights),
    };
    if (s[anchor] > tol) align = s.left <= tol ? 'left' : s.center <= tol ? 'center' : s.right <= tol ? 'right' : anchor;
  }

  const minL = Math.min(...lefts);
  const maxR = Math.max(...rights);
  const lineHeight = keep.length > 1 ? (baselines[baselines.length - 1] - baselines[0]) / (keep.length - 1) / fontUser : undefined;
  const ls = parseFloat(dom.cs.letterSpacing);
  const fill = parseCssColour(dom.cs.fill);
  const fillOpacity = parseFloat(dom.cs.fillOpacity);
  const opacity = effectiveOpacity(t, root) * (Number.isFinite(fillOpacity) ? fillOpacity : 1);
  const label = t.getAttribute('id') || t.getAttribute('data-name') || t.getAttribute('inkscape:label');
  const text = keep.map((k) => k.s).join('\n');
  // Illustrator-style SVGs put the weight in the family name ('National2Condensed-Bold') and leave font-weight normal.
  const family = dom.cs.fontFamily || 'sans-serif';
  const cssWeight = parseWeight(dom.cs.fontWeight);
  const nameWeight = weightFromName(family.split(',')[0] ?? '');
  const weight = nameWeight && (!cssWeight || cssWeight === 400) ? nameWeight : cssWeight;
  const spec: TextSpec = {
    name: label || text.split('\n')[0].slice(0, 40),
    text,
    sourceFont: family,
    weight,
    stretch: dom.cs.fontStretch,
    fontPx: fontUser * frame.sy,
    lineHeight,
    letterSpacing: Number.isFinite(ls) ? ls * frame.sx : 0,
    align,
    fill,
    opacity,
    left: 0,
    right: 0,
  };
  const rotated = isRotated(frame);
  if (!rotated) {
    const [x0] = apply(frame, minL, baselines[0]);
    const [x1] = apply(frame, maxR, baselines[0]);
    spec.left = Math.min(x0, x1);
    spec.right = Math.max(x0, x1);
    spec.baseline = apply(frame, minL, baselines[0])[1];
  } else {
    const cos = frame.a / frame.sx;
    const sin = frame.b / frame.sx;
    spec.left = minL * frame.sx;
    spec.right = maxR * frame.sx;
    spec.baseline = baselines[0] * frame.sy;
    spec.rotation = frame.rotation;
    spec.toDesign = (x, y) => [frame.e + cos * x - sin * y, frame.f + sin * x + cos * y];
  }
  const fontPx = spec.fontPx;
  const box = {
    x: spec.left,
    y: (spec.baseline ?? 0) - fontPx * 0.75,
    width: spec.right - spec.left,
    height: fontPx * 0.95 + (keep.length - 1) * fontPx * (lineHeight ?? 1.2),
  };
  return { spec, box, lines: keep.length, rotated };
}

// ---------------------------------------------------------------------------------------------
// CTA buttons: a solid rect painted just behind a short single-line text.

interface RectInfo {
  el: SVGRectElement;
  box: { x: number; y: number; width: number; height: number };
  fill: RGB;
  radius: number;
  used: boolean;
}

function readRects(root: SVGSVGElement, origin: DOMRect, W: number, H: number): RectInfo[] {
  const out: RectInfo[] = [];
  for (const el of Array.from(root.querySelectorAll('rect')) as SVGRectElement[]) {
    if (nonRendered(el, root) || hidden(el, root) || clippedOrFiltered(el, root)) continue;
    const cs = getComputedStyle(el);
    const fill = parseCssColour(cs.fill);
    const fo = parseFloat(cs.fillOpacity);
    if (!fill || (Number.isFinite(fo) && fo < 0.9) || effectiveOpacity(el, root) < 0.9) continue;
    const f = frameOf(el, origin);
    if (!f || isRotated(f)) continue;
    const bb = el.getBBox();
    const b = designBox(f, bb.x, bb.y, bb.width, bb.height);
    if (b.width * b.height > W * H * 0.12 || b.width > W * 0.95) continue;
    const rx = el.rx.baseVal.value || el.ry.baseVal.value || 0;
    out.push({ el, box: b, fill, radius: Math.min(rx * f.sx, b.height / 2), used: false });
  }
  return out;
}

function matchButton(g: TextGeom, t: Element, rects: RectInfo[]): RectInfo | null {
  if (g.rotated || g.lines !== 1 || g.spec.text.split(/\s+/).length > 6) return null;
  const tb = g.box;
  const fontPx = g.spec.fontPx;
  let best: RectInfo | null = null;
  for (const r of rects) {
    if (r.used) continue;
    // painted before (= behind) the text
    if (!(r.el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const b = r.box;
    const pad = 2;
    if (tb.x < b.x - pad || tb.x + tb.width > b.x + b.width + pad) continue;
    if (tb.y < b.y - pad || tb.y + tb.height > b.y + b.height + pad) continue;
    if (b.height > fontPx * 3.5) continue;
    if (Math.abs(tb.x + tb.width / 2 - (b.x + b.width / 2)) > b.width * 0.25) continue;
    if (!best || b.width * b.height < best.box.width * best.box.height) best = r;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Rasterizing

async function rasterize(markup: string, W: number, H: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const c = makeCanvas(W, H);
    ctx2d(c).drawImage(img, 0, 0, W, H);
    return c;
  } catch {
    throw new ImportError('This SVG could not be rendered — it may use features the browser cannot draw.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

const ALIGN_X: Record<number, number> = { 2: 0, 3: 0.5, 4: 1, 5: 0, 6: 0.5, 7: 1, 8: 0, 9: 0.5, 10: 1 };
const ALIGN_Y: Record<number, number> = { 2: 0, 3: 0, 4: 0, 5: 0.5, 6: 0.5, 7: 0.5, 8: 1, 9: 1, 10: 1 };

interface PendingImage {
  layer: ImageLayer;
  make: () => Promise<Uploaded>;
}

async function readImage(el: SVGImageElement, root: SVGSVGElement, origin: DOMRect, id: string): Promise<PendingImage | null> {
  const href = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href') || '';
  if (!/^data:image\//i.test(href)) return null;
  const f = frameOf(el, origin);
  if (!f) return null;
  const img = await loadImage(href);
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return null;
  let bx = el.x.baseVal.value;
  let by = el.y.baseVal.value;
  let bw = el.width.baseVal.value;
  let bh = el.height.baseVal.value;
  if (!bw && !bh) [bw, bh] = [nw, nh];
  else if (!bw) bw = (bh * nw) / nh;
  else if (!bh) bh = (bw * nh) / nw;
  const par = el.preserveAspectRatio.baseVal;
  const slice = par.meetOrSlice === 2;
  let draw: { x: number; y: number; w: number; h: number } = { x: bx, y: by, w: bw, h: bh };
  let render: (() => HTMLCanvasElement) | null = null;
  if (par.align === 1) {
    // 'none': stretched to the box
    render = () => {
      const k = clamp(nw / Math.max(1, bw * f.sx), 1, 2);
      const c = makeCanvas(bw * f.sx * k, bh * f.sy * k);
      ctx2d(c).drawImage(img, 0, 0, c.width, c.height);
      return c;
    };
  } else {
    const s = slice ? Math.max(bw / nw, bh / nh) : Math.min(bw / nw, bh / nh);
    const iw = nw * s;
    const ih = nh * s;
    const ax = ALIGN_X[par.align] ?? 0.5;
    const ay = ALIGN_Y[par.align] ?? 0.5;
    if (!slice) {
      draw = { x: bx + (bw - iw) * ax, y: by + (bh - ih) * ay, w: iw, h: ih };
    } else {
      render = () => {
        const sw = bw / s;
        const sh = bh / s;
        const c = makeCanvas(Math.min(sw, bw * f.sx * 2), Math.min(sh, bh * f.sy * 2));
        ctx2d(c).drawImage(img, (nw - sw) * ax, (nh - sh) * ay, sw, sh, 0, 0, c.width, c.height);
        return c;
      };
    }
  }
  bx = draw.x;
  by = draw.y;
  const b = designBox(f, bx, by, draw.w, draw.h);
  const opacity = effectiveOpacity(el, root);
  const label = el.getAttribute('id') || el.getAttribute('data-name') || el.getAttribute('inkscape:label');
  const layer: ImageLayer = {
    id,
    kind: 'image',
    name: label || `Image ${id.split('-')[1]}`,
    src: '',
    x: r1(b.x),
    y: r1(b.y),
    width: r1(b.width),
    height: r1(b.height),
  };
  if (b.rotation) layer.rotation = r1(b.rotation);
  if (opacity < 0.99) layer.opacity = r2(opacity);
  const make = async (): Promise<Uploaded> => {
    if (render) return uploadCanvas(render(), layer.name ?? id);
    const blob = await (await fetch(href)).blob();
    if (/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) return uploadBlob(blob, `${id}.${blob.type.split('/')[1]}`);
    // e.g. nested SVG: the backend only stores raster images
    const c = makeCanvas(Math.min(nw * 2, b.width * 2), Math.min(nh * 2, b.height * 2));
    ctx2d(c).drawImage(img, 0, 0, c.width, c.height);
    return uploadCanvas(c, layer.name ?? id);
  };
  return { layer, make };
}

// ---------------------------------------------------------------------------------------------

function parseSvg(source: string): Document {
  const parse = (s: string) => new DOMParser().parseFromString(s, 'image/svg+xml');
  let doc = parse(source);
  let root = doc.documentElement;
  if (root?.localName === 'svg' && root.namespaceURI !== SVG_NS && !doc.querySelector('parsererror')) {
    // Missing xmlns (inline-HTML style SVG): add it and re-parse.
    doc = parse(source.replace(/<svg\b/, `<svg xmlns="${SVG_NS}"`));
    root = doc.documentElement;
  }
  if (!root || doc.getElementsByTagName('parsererror').length || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    throw new ImportError("This SVG couldn't be read — the file looks corrupt or isn't valid SVG/XML.");
  }
  return doc;
}

export async function importSvg(file: File): Promise<ImportResult> {
  const source = await file.text();
  if (!source.trim()) throw new ImportError(`${file.name} is empty.`);
  const doc = parseSvg(source);
  const root = doc.documentElement as unknown as SVGSVGElement;
  const report = sanitizeSvg(root);

  // Size: 1080 wide, aspect from width/height (absolute units) or the viewBox.
  let vb = parseViewBox(root.getAttribute('viewBox'));
  const wa = parseLength(root.getAttribute('width'));
  const ha = parseLength(root.getAttribute('height'));
  if (!vb && wa && ha) vb = [0, 0, wa, ha];
  const W = DESIGN_W;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  const shadow = host.attachShadow({ mode: 'open' });
  const live = document.importNode(root, true) as SVGSVGElement;
  shadow.appendChild(live);
  const place = (w: number, h: number) => {
    host.style.cssText = `position:fixed;left:${-(w + 50000)}px;top:0;width:${w}px;height:${h}px;overflow:hidden;pointer-events:none;opacity:0;`;
    for (const el of [live, root]) {
      el.setAttribute('width', String(w));
      el.setAttribute('height', String(h));
      (el as SVGSVGElement).style?.setProperty('width', `${w}px`);
      (el as SVGSVGElement).style?.setProperty('height', `${h}px`);
      (el as SVGSVGElement).style?.setProperty('display', 'block');
    }
  };
  place(W, Math.round(W * 1.25));
  document.body.appendChild(host);
  try {
    if (!vb) {
      // No size at all: use the content's extent.
      const bb = live.getBBox();
      vb = [0, 0, Math.max(1, bb.x + bb.width), Math.max(1, bb.y + bb.height)];
    }
    const aspect = wa && ha ? ha / wa : vb[3] / vb[2];
    const H = clamp(Math.round(W * aspect), 1, 8192);
    for (const el of [live, root]) el.setAttribute('viewBox', vb.join(' '));
    place(W, H);
    const previewMarkup = new XMLSerializer().serializeToString(root);

    live.getBBox(); // force layout so web fonts referenced by the SVG start loading
    await ensureBrandFonts();
    await Promise.race([document.fonts.ready, sleep(3000)]);
    const origin = live.getBoundingClientRect();

    const nextId = idMaker();
    const artId = nextId('image');
    const ordered: (
      | { type: 'text'; el: SVGTextElement; geom: TextGeom }
      | { type: 'button'; el: SVGTextElement; geom: TextGeom; rect: RectInfo }
      | { type: 'image'; pending: PendingImage }
    )[] = [];
    let hiddenCount = 0;
    let textPathCount = 0;
    let keptImages = 0;
    let droppedImages = 0;
    const rects = readRects(live, origin, W, H);

    for (const el of Array.from(live.querySelectorAll('text, image')) as (SVGTextElement | SVGImageElement)[]) {
      if (nonRendered(el, live)) continue;
      if (el.localName === 'text' && el.parentElement?.closest('text')) continue; // nested (invalid) text
      if (hidden(el, live)) {
        hiddenCount++;
        continue;
      }
      if (el.localName === 'text') {
        const t = el as SVGTextElement;
        if (t.querySelector('textPath')) {
          textPathCount++;
          continue;
        }
        const geom = readText(t, live, origin);
        if (!geom) continue;
        const rect = matchButton(geom, t, rects);
        if (rect) {
          rect.used = true;
          rect.el.setAttribute(IMPORTED, '1');
          ordered.push({ type: 'button', el: t, geom, rect });
        } else ordered.push({ type: 'text', el: t, geom });
        t.setAttribute(IMPORTED, '1');
      } else {
        const im = el as SVGImageElement;
        const href = im.getAttribute('href') || im.getAttributeNS(XLINK_NS, 'href') || '';
        if (!/^data:image\//i.test(href)) {
          droppedImages++; // linked file (or a stripped unsafe link): nothing we can upload
          continue;
        }
        if (clippedOrFiltered(im, live)) {
          keptImages++;
          continue;
        }
        let pending: PendingImage | null = null;
        try {
          pending = await readImage(im, live, origin, nextId('image'));
        } catch {
          pending = null;
        }
        if (!pending) {
          droppedImages++;
          continue;
        }
        im.setAttribute(IMPORTED, '1');
        ordered.push({ type: 'image', pending });
      }
    }

    // Artwork = the SVG minus everything we extracted.
    const art = live.cloneNode(true) as SVGSVGElement;
    art.querySelectorAll(`[${IMPORTED}]`).forEach((e) => e.remove());
    const [artCanvas, previewCanvas] = await Promise.all([
      rasterize(new XMLSerializer().serializeToString(art), W, H),
      rasterize(previewMarkup, W, H),
    ]);
    const hasArt = !isBlank(artCanvas);
    const behind = new PixelSampler(artCanvas, W);

    // Build layers bottom -> top.
    const fonts = new Map<string, string>();
    const layers: Layer[] = [];
    const uploads: { make: () => Promise<Uploaded>; apply: (u: Uploaded) => void }[] = [];
    let artLayer: ImageLayer | null = null;
    if (hasArt) {
      artLayer = {
        id: artId,
        kind: 'image',
        role: 'flat-image',
        name: 'Artwork (vector shapes)',
        src: '',
        x: 0,
        y: 0,
        width: W,
        height: H,
        locked: false,
      };
      const al = artLayer;
      layers.push(al);
      uploads.push({ make: () => uploadCanvas(artCanvas, 'svg-artwork'), apply: (u) => (al.src = u.url) });
    }
    let texts = 0;
    let buttons = 0;
    let images = 0;
    let snapped = 0;
    for (const item of ordered) {
      if (item.type === 'image') {
        const l = item.pending.layer;
        layers.push(l);
        uploads.push({ make: item.pending.make, apply: (u) => (l.src = u.url) });
        images++;
      } else if (item.type === 'text') {
        const l = buildTextLayer(item.geom.spec, nextId('text'), W, fonts, behind);
        if (!isBrandTextColour(item.geom.spec.fill)) snapped++;
        layers.push(l);
        texts++;
      } else {
        const { spec } = item.geom;
        const r = item.rect;
        const b: ButtonLayer = {
          id: nextId('button'),
          kind: 'button',
          role: 'cta',
          name: spec.name,
          x: r1(r.box.x),
          y: r1(r.box.y),
          width: r1(r.box.width),
          height: r1(r.box.height),
          text: spec.text,
          fill: nearestToken(r.fill, ALL_TOKENS),
          textFill: snapTextColour(spec.fill, r.fill),
          fontSize: r1(spec.fontPx),
          cornerRadius: r1(r.radius),
        };
        layers.push(b);
        buttons++;
      }
    }

    // Uploads: layer bitmaps + flattened preview.
    let previewUrl = '';
    uploads.push({ make: () => uploadCanvas(previewCanvas, `${baseName(file.name)}-preview`), apply: (u) => (previewUrl = u.url) });
    const results = await pool(uploads, UPLOAD_CONCURRENCY, (u) => u.make());
    results.forEach((u, i) => uploads[i].apply(u));

    const design: Design = {
      id: `import-${Date.now().toString(36)}`,
      name: baseName(file.name),
      width: W,
      height: H,
      background: backgroundOf(previewCanvas),
      layers,
    };

    const parts = [plural(texts, 'text'), buttons ? plural(buttons, 'button') : '', images ? plural(images, 'image') : '', hasArt ? '1 artwork' : '']
      .filter(Boolean)
      .join(', ');
    const notes = [`Imported ${file.name} as ${plural(layers.length, 'editable layer')} (${parts}).`];
    if (hasArt) notes.push('Vector shapes were flattened into one movable artwork image at the bottom.');
    if (buttons) notes.push(`${plural(buttons, 'rectangle + label pair')} turned into editable CTA ${buttons === 1 ? 'button' : 'buttons'}.`);
    if (hiddenCount) notes.push(`${plural(hiddenCount, 'hidden element')} skipped.`);
    if (textPathCount) notes.push(`${plural(textPathCount, 'text-on-path element')} kept in the artwork (not editable).`);
    if (!texts && !buttons) notes.push('No live text in this SVG (it was probably converted to outlines) — use "recreate" to rebuild it as editable layers.');
    if (keptImages) notes.push(`${plural(keptImages, 'clipped/masked image')} kept inside the artwork.`);
    if (droppedImages) notes.push(`${plural(droppedImages, 'linked image')} skipped — only images embedded in the SVG can be imported.`);
    const fn = fontNote(fonts);
    if (fn) notes.push(fn);
    if (snapped) notes.push(`Text colours snapped to brand navy/white.`);
    const removed = report.elements + report.handlers + report.links;
    if (removed) {
      notes.push(
        `Removed unsafe SVG content: ${[
          report.elements ? plural(report.elements, 'element') : '',
          report.handlers ? plural(report.handlers, 'event handler') : '',
          report.links ? plural(report.links, 'external link') : '',
        ]
          .filter(Boolean)
          .join(', ')}.`,
      );
    }
    return { kind: 'svg', design, previewUrl, notes };
  } finally {
    host.remove();
  }
}

// Exposed for unit tests.
export const __svgTest = { parseLength, parseViewBox };
