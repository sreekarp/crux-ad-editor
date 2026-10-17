// Offscreen compositing for photo layers: cover-fit + zoom/focus, then a bloom mask (destination-in)
// or a rounded-rect clip. The result is drawn by a single Konva Image.

export interface PhotoParams {
  width: number;
  height: number;
  zoom: number;
  focusX: number;
  focusY: number;
  cornerRadius: number;
  /** Max output dimension in px (2048 for the editor/export, smaller for thumbnails). */
  cap: number;
}

function makeCanvas(w: number, h: number, cap: number) {
  const s = Math.min(1, cap / Math.max(w, h, 1));
  const cw = Math.max(1, Math.round(w * s));
  const ch = Math.max(1, Math.round(h * s));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  return { canvas, ctx: canvas.getContext('2d'), s, cw, ch };
}

function roundRectPath(ctx: CanvasRenderingContext2D, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(rr, 0);
  ctx.lineTo(w - rr, 0);
  ctx.arcTo(w, 0, w, rr, rr);
  ctx.lineTo(w, h - rr);
  ctx.arcTo(w, h, w - rr, h, rr);
  ctx.lineTo(rr, h);
  ctx.arcTo(0, h, 0, h - rr, rr);
  ctx.lineTo(0, rr);
  ctx.arcTo(0, 0, rr, 0, rr);
  ctx.closePath();
}

const clamp01 = (v: number, d = 0.5) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

/** Photo cover-fitted into the box, scaled by zoom (>= 1), positioned by focus (0..1), then masked or clipped. */
export function composePhoto(img: HTMLImageElement, mask: HTMLImageElement | null, p: PhotoParams): HTMLCanvasElement | null {
  const { canvas, ctx, s, cw, ch } = makeCanvas(p.width, p.height, p.cap);
  if (!ctx) return null;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  const zoom = Math.max(1, Number.isFinite(p.zoom) ? p.zoom : 1);
  const k = Math.max(cw / iw, ch / ih) * zoom;
  const dw = iw * k;
  const dh = ih * k;
  const dx = (cw - dw) * clamp01(p.focusX);
  const dy = (ch - dh) * clamp01(p.focusY);
  ctx.imageSmoothingQuality = 'high';
  if (mask) {
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0, cw, ch);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.save();
    roundRectPath(ctx, cw, ch, (p.cornerRadius || 0) * s);
    ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }
  return canvas;
}

/** Flat-colour placeholder in the photo's shape (bloom mask or rounded rect). */
export function composePlaceholder(
  colour: string,
  mask: HTMLImageElement | null,
  p: Pick<PhotoParams, 'width' | 'height' | 'cornerRadius' | 'cap'>,
): HTMLCanvasElement | null {
  const { canvas, ctx, s, cw, ch } = makeCanvas(p.width, p.height, p.cap);
  if (!ctx) return null;
  ctx.fillStyle = colour;
  if (mask) {
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0, cw, ch);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    roundRectPath(ctx, cw, ch, (p.cornerRadius || 0) * s);
    ctx.fill();
  }
  return canvas;
}
