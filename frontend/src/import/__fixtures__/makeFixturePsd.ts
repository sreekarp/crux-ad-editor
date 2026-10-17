// Generates the PSD import fixture in the browser with ag-psd's writePsd (xero-like.psd is its saved output).
// Document is 1.5x the 1080x1350 design so the importer's scaling is exercised.
// Layers (bottom -> top): Background (navy pixels) · group "Hero" [Sky bloom (opacity 0.8), Old photo (hidden)] ·
// Brightness/Contrast adjustment · Headline / Sub (type) · CTA box (pixels) · CTA (type) · Coin (pixels).
// Type layers carry rendered pixels too, like Photoshop saves them.
import { writePsd, type Layer, type Psd } from 'ag-psd';

const NAVY = '#000856';
const SKY = '#3ECCFF';
const WHITE = '#FFFFFF';
const PINK = '#FF719B';
const YELLOW = '#FDCC08';

export interface FixtureOptions {
  /** Write the flattened composite (default true). Without it the importer must composite the layers itself. */
  composite?: boolean;
  /** Write layers (default true). false = composite-only PSD (imported as a flat image). */
  layers?: boolean;
  /** Document scale relative to 1080x1350 (default 1.5). */
  scale?: number;
  /** Put the ad in a 4:5 artboard to the right of a 1:1 artboard (the importer should pick the 4:5 one). */
  artboards?: boolean;
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d context');
  draw(g);
  return c;
}

export async function makeXeroPsd(opts: FixtureOptions = {}): Promise<ArrayBuffer> {
  const k = opts.scale ?? 1.5;
  const W = Math.round(1080 * k);
  const H = Math.round(1350 * k);
  // Artboard mode: a 1:1 board at x=0 and the 4:5 ad board at x=BX.
  const BX = opts.artboards ? Math.round(1200 * k) : 0;
  const DW = BX + W;
  await Promise.all([document.fonts.load('800 40px "Barlow Condensed"'), document.fonts.load('500 20px Inter'), document.fonts.load('700 20px Inter')]);
  const full = (draw: (g: CanvasRenderingContext2D) => void) =>
    canvas(DW, H, (g) => {
      g.translate(BX, 0);
      draw(g);
    });

  const background = full((g) => {
    g.fillStyle = NAVY;
    g.fillRect(0, 0, W, H);
  });
  const bloom = full((g) => {
    g.fillStyle = SKY;
    g.beginPath();
    g.moveTo(1080 * k, 640 * k);
    g.bezierCurveTo(940 * k, 600 * k, 820 * k, 700 * k, 780 * k, 840 * k);
    g.bezierCurveTo(740 * k, 980 * k, 600 * k, 1040 * k, 470 * k, 1110 * k);
    g.bezierCurveTo(360 * k, 1170 * k, 300 * k, 1260 * k, 290 * k, 1350 * k);
    g.lineTo(1080 * k, 1350 * k);
    g.closePath();
    g.fill();
  });
  const oldPhoto = full((g) => {
    g.fillStyle = PINK;
    g.fillRect(100 * k, 800 * k, 400 * k, 300 * k);
  });

  // Headline: 96px design, leading 100px, first baseline y=200 at x=64.
  const hl = { x: 64 * k, y: 200 * k, size: 96 * k, leading: 100 * k };
  const headline = full((g) => {
    g.fillStyle = WHITE;
    g.font = `800 ${hl.size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    g.fillText('Cash flow without', hl.x, hl.y);
    g.fillText('the suspense.', hl.x, hl.y + hl.leading);
  });
  // Sub: 34px Inter Medium, baseline y=372.
  const sb = { x: 64 * k, y: 372 * k, size: 34 * k };
  const sub = full((g) => {
    g.fillStyle = WHITE;
    g.font = `500 ${sb.size}px Inter, Arial, sans-serif`;
    g.fillText('All your numbers in one place.', sb.x, sb.y);
  });
  // CTA: sky rounded box 300x84 at (64, 420), label 30px Inter Bold centred.
  const box = { x: 64 * k, y: 420 * k, w: 300 * k, h: 84 * k, r: 12 * k };
  const ctaBox = full((g) => {
    g.fillStyle = SKY;
    g.beginPath();
    g.roundRect(box.x, box.y, box.w, box.h, box.r);
    g.fill();
  });
  const cta = { x: box.x + box.w / 2, y: box.y + box.h / 2 + 0.36 * 30 * k, size: 30 * k };
  const ctaLabel = full((g) => {
    g.fillStyle = NAVY;
    g.font = `700 ${cta.size}px Inter, Arial, sans-serif`;
    g.textAlign = 'center';
    g.fillText('Try Xero free', cta.x, cta.y);
  });
  const coin = full((g) => {
    const cx = 830 * k;
    const cy = 950 * k;
    g.fillStyle = YELLOW;
    g.beginPath();
    g.arc(cx, cy, 130 * k, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = NAVY;
    g.lineWidth = 12 * k;
    g.beginPath();
    g.arc(cx, cy, 95 * k, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 16 * k;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(cx - 45 * k, cy + 2 * k);
    g.lineTo(cx - 12 * k, cy + 36 * k);
    g.lineTo(cx + 48 * k, cy - 34 * k);
    g.stroke();
  });

  const white = { r: 255, g: 255, b: 255 };
  const navy = { r: 0, g: 8, b: 86 };
  const children: Layer[] = [
    { name: 'Background', canvas: background },
    {
      name: 'Hero',
      opened: true,
      children: [
        { name: 'Sky bloom', canvas: bloom, opacity: 0.8 },
        { name: 'Old photo', canvas: oldPhoto, hidden: true },
      ],
    },
    { name: 'Brightness/Contrast', adjustment: { type: 'brightness/contrast', brightness: 8, contrast: 4 } },
    {
      name: 'Headline',
      canvas: headline,
      text: {
        text: 'Cash flow without\nthe suspense.',
        transform: [1, 0, 0, 1, BX + hl.x, hl.y],
        style: { font: { name: 'National2Condensed-Bold' }, fontSize: hl.size, fillColor: white, autoLeading: false, leading: hl.leading },
        paragraphStyle: { justification: 'left' },
      },
    },
    {
      name: 'Sub',
      canvas: sub,
      text: {
        text: 'All your numbers in one place.',
        transform: [1, 0, 0, 1, BX + sb.x, sb.y],
        style: { font: { name: 'Inter-Medium' }, fontSize: sb.size, fillColor: white },
        paragraphStyle: { justification: 'left' },
      },
    },
    { name: 'CTA box', canvas: ctaBox },
    {
      name: 'CTA',
      canvas: ctaLabel,
      text: {
        text: 'Try Xero free',
        transform: [1, 0, 0, 1, BX + cta.x, cta.y],
        style: { font: { name: 'Inter-Bold' }, fontSize: cta.size, fillColor: navy },
        paragraphStyle: { justification: 'center' },
      },
    },
    { name: 'Coin', canvas: coin },
  ];

  const square = canvas(DW, H, (g) => {
    g.fillStyle = SKY;
    g.fillRect(0, 0, W, W);
  });
  const top: Layer[] = opts.artboards
    ? [
        { name: 'Square 1:1', artboard: { rect: { top: 0, left: 0, bottom: W, right: W } }, children: [{ name: 'Square bg', canvas: square }] },
        { name: 'Feed 4:5', artboard: { rect: { top: 0, left: BX, bottom: H, right: BX + W } }, children },
      ]
    : children;

  const psd: Psd = { width: DW, height: H };
  if (opts.layers !== false) psd.children = top;
  if (opts.composite !== false) {
    psd.canvas = canvas(DW, H, (g) => {
      const layers: [HTMLCanvasElement, number][] = [
        [background, 1],
        [bloom, 0.8],
        [headline, 1],
        [sub, 1],
        [ctaBox, 1],
        [ctaLabel, 1],
        [coin, 1],
      ];
      if (opts.artboards) layers.unshift([square, 1]);
      for (const [c, a] of layers) {
        g.globalAlpha = a;
        g.drawImage(c, 0, 0);
      }
    });
  }
  return writePsd(psd, { trimImageData: true });
}
