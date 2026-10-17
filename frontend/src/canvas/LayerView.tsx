// One Konva node per layer kind. Pure rendering: positions are local to the layer's Group (0,0 = layer.x/y).
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type Konva from 'konva';
import { Circle, Image as KImage, Line, Rect, Text } from 'react-konva';
import { assetUrl, FONTS, PALETTE } from '../brand';
import { measureText } from '../design';
import { useImg } from '../lib/images';
import type {
  BgShapeLayer,
  BloomLayer,
  ButtonLayer,
  Layer,
  LogoLayer,
  PhotoLayer,
  StatLayer,
  TagsLayer,
  TextLayer,
} from '../types';
import { composePhoto, composePlaceholder } from './photo';

export type Detail = 'full' | 'thumb';

export const GREEN = '#2DB879';

/** Colour token -> hex (raw hex passes through so a stray LLM value never crashes the renderer). */
export function col(token: string | null | undefined, fallback = 'rgba(0,0,0,0)'): string {
  if (!token) return fallback;
  return (PALETTE as Record<string, string>)[token] ?? token;
}

export function containFit(iw: number, ih: number, w: number, h: number) {
  if (!iw || !ih) return { x: 0, y: 0, width: w, height: h };
  const s = Math.min(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  return { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh };
}

const fontFamily = (f: string | undefined) => (f === 'headline' ? FONTS.headline : FONTS.body);

// ---------------------------------------------------------------------------------------------

function TextView({
  layer,
  hideText,
  onMeasured,
}: {
  layer: TextLayer;
  hideText?: boolean;
  onMeasured?: (id: string, height: number) => void;
}) {
  const ref = useRef<Konva.Text>(null);
  const text = layer.uppercase ? (layer.text ?? '').toUpperCase() : layer.text ?? '';
  useLayoutEffect(() => {
    if (!onMeasured || !ref.current) return;
    const h = ref.current.height();
    if (Number.isFinite(h) && h > 0 && Math.abs(h - layer.height) > 1) onMeasured(layer.id, h);
  });
  return (
    <Text
      ref={ref}
      text={text}
      width={Math.max(1, layer.width)}
      fontFamily={fontFamily(layer.font)}
      fontSize={layer.fontSize || 32}
      fontStyle={String(layer.fontWeight || 400)}
      fill={col(layer.fill, PALETTE.navy)}
      align={layer.align || 'left'}
      lineHeight={layer.lineHeight || 1}
      letterSpacing={layer.letterSpacing ?? 0}
      wrap="word"
      opacity={hideText ? 0 : 1}
      listening={false}
    />
  );
}

function ButtonView({ layer, hideText }: { layer: ButtonLayer; hideText?: boolean }) {
  return (
    <>
      <Rect width={layer.width} height={layer.height} fill={col(layer.fill, PALETTE.sky)} cornerRadius={layer.cornerRadius ?? 0} listening={false} />
      <Text
        text={layer.text ?? ''}
        width={layer.width}
        height={layer.height}
        align="center"
        verticalAlign="middle"
        fontFamily={FONTS.body}
        fontStyle="700"
        fontSize={layer.fontSize || 28}
        fill={col(layer.textFill, PALETTE.navy)}
        wrap="none"
        opacity={hideText ? 0 : 1}
        listening={false}
      />
    </>
  );
}

function LogoView({ layer }: { layer: LogoLayer }) {
  const [img] = useImg(assetUrl.logo(layer.colour || 'navy'));
  const { width: w, height: h } = layer;
  const inset = layer.pill ? h * 0.22 : 0;
  const bw = Math.max(1, w - inset * 2);
  const bh = Math.max(1, h - inset * 2);
  const fit = img ? containFit(img.naturalWidth, img.naturalHeight, bw, bh) : null;
  return (
    <>
      {layer.pill ? <Rect width={w} height={h} cornerRadius={h / 2} fill={col(layer.pill)} listening={false} /> : null}
      {img && fit ? (
        <KImage image={img} x={inset + fit.x} y={inset + fit.y} width={fit.width} height={fit.height} listening={false} />
      ) : null}
    </>
  );
}

function StretchImage({
  url,
  w,
  h,
  flipX,
  flipY,
  pixelHit,
}: {
  url: string;
  w: number;
  h: number;
  flipX?: boolean;
  flipY?: boolean;
  pixelHit?: boolean;
}) {
  const [img] = useImg(url);
  const ref = useRef<Konva.Image>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !img || !pixelHit) return;
    try {
      // Pixel-accurate hit area so big blooms don't swallow clicks meant for layers below them.
      node.cache({ hitCanvasPixelRatio: 0.25 });
      node.drawHitFromCache(0.5);
    } catch {
      /* ignore (e.g. zero-size) */
    }
    return () => {
      try {
        node.clearCache();
      } catch {
        /* ignore */
      }
    };
  }, [img, w, h, flipX, flipY, pixelHit]);
  if (!img) return null;
  return (
    <KImage
      ref={ref}
      image={img}
      width={w}
      height={h}
      x={flipX ? w : 0}
      y={flipY ? h : 0}
      scaleX={flipX ? -1 : 1}
      scaleY={flipY ? -1 : 1}
      listening={!!pixelHit}
    />
  );
}

function ContainImage({ url, w, h }: { url: string; w: number; h: number }) {
  const [img] = useImg(url);
  if (!img) return null;
  const fit = containFit(img.naturalWidth, img.naturalHeight, w, h);
  return <KImage image={img} {...fit} listening={false} />;
}

function PhotoView({ layer, detail }: { layer: PhotoLayer; detail: Detail }) {
  const [img, status] = useImg(layer.src);
  const [maskImg, maskStatus] = useImg(layer.mask ? assetUrl.mask(layer.mask) : null);
  const maskPending = !!layer.mask && maskStatus === 'loading';
  const cap = detail === 'thumb' ? 640 : 2048;
  const w = Math.max(1, layer.width);
  const h = Math.max(1, layer.height);
  const r = layer.cornerRadius ?? 0;

  const photo = useMemo(() => {
    if (!img || maskPending) return null;
    return composePhoto(img, maskImg ?? null, {
      width: w,
      height: h,
      zoom: layer.zoom,
      focusX: layer.focusX,
      focusY: layer.focusY,
      cornerRadius: r,
      cap,
    });
  }, [img, maskImg, maskPending, w, h, layer.zoom, layer.focusX, layer.focusY, r, cap]);

  const placeholder = useMemo(() => {
    if (photo || maskPending) return null;
    return composePlaceholder(PALETTE.sky, maskImg ?? null, { width: w, height: h, cornerRadius: r, cap: Math.min(cap, 1024) });
  }, [photo, maskPending, maskImg, w, h, r, cap]);

  const failed = (layer.src && status === 'failed') || layer.status === 'error';
  const generating = layer.status === 'loading' || (!photo && !failed && (!layer.src || status === 'loading'));
  const label = generating ? 'Generating photo…' : !photo && failed ? 'Photo unavailable' : '';
  const fs = Math.max(14, Math.min(44, w * 0.045));
  const pillW = Math.min(w * 0.8, fs * 10.5);
  const pillH = fs * 2.2;

  return (
    <>
      {photo ? <KImage image={photo} width={w} height={h} listening={false} /> : null}
      {!photo && placeholder ? <KImage image={placeholder} width={w} height={h} listening={false} /> : null}
      {label ? (
        <>
          {photo ? (
            <Rect
              x={(w - pillW) / 2}
              y={(h - pillH) / 2}
              width={pillW}
              height={pillH}
              cornerRadius={pillH / 2}
              fill="rgba(255,255,255,0.9)"
              listening={false}
            />
          ) : null}
          <Text
            text={label}
            width={w}
            height={h}
            align="center"
            verticalAlign="middle"
            fontFamily={FONTS.body}
            fontStyle="600"
            fontSize={fs}
            fill={PALETTE.navy}
            listening={false}
          />
        </>
      ) : null}
    </>
  );
}

function CheckBadge({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <>
      <Circle x={cx} y={cy} radius={r} fill={GREEN} listening={false} />
      <Line
        points={[cx - r * 0.42, cy + r * 0.02, cx - r * 0.1, cy + r * 0.33, cx + r * 0.45, cy - r * 0.3]}
        stroke="#FFFFFF"
        strokeWidth={Math.max(1, r * 0.3)}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />
    </>
  );
}

function TagsView({ layer }: { layer: TagsLayer }) {
  const items = (layer.items ?? []).filter(Boolean).map((t) => String(t).toUpperCase());
  const n = items.length;
  if (!n) return null;
  const fs = layer.fontSize || 28;
  const cols = Math.max(1, Math.min(layer.columns || 1, n));
  const rows = Math.ceil(n / cols);
  const rowH = layer.height / rows;
  const r = fs * 0.48;
  const gap = fs * 0.32;
  const ls = fs * 0.02;
  const widths = items.map((t) => measureText(t, 'headline', 700, fs, ls));
  const nodes: React.ReactNode[] = [];
  for (let row = 0; row < rows; row++) {
    const idx = Array.from({ length: Math.min(cols, n - row * cols) }, (_, i) => row * cols + i);
    let xs: number[];
    if (cols >= 3) {
      // One strip: spread items edge to edge (space-between), never tighter than half an em.
      const natural = idx.map((i) => 2 * r + gap + widths[i]);
      const total = natural.reduce((a, b) => a + b, 0);
      const spacing = idx.length > 1 ? Math.max(fs * 0.5, (layer.width - total) / (idx.length - 1)) : 0;
      xs = [];
      let x = 0;
      natural.forEach((nw) => {
        xs.push(x);
        x += nw + spacing;
      });
    } else {
      xs = idx.map((_, c) => (c * layer.width) / cols);
    }
    idx.forEach((i, c) => {
      const cy = row * rowH + rowH / 2;
      nodes.push(<CheckBadge key={`c${i}`} cx={xs[c] + r} cy={cy} r={r} />);
      nodes.push(
        <Text
          key={`t${i}`}
          x={xs[c] + 2 * r + gap}
          y={row * rowH}
          height={rowH}
          verticalAlign="middle"
          text={items[i]}
          fontFamily={FONTS.headline}
          fontStyle="700"
          fontSize={fs}
          letterSpacing={ls}
          fill={col(layer.fill, PALETTE.navy)}
          wrap="none"
          listening={false}
        />,
      );
    });
  }
  return <>{nodes}</>;
}

const SPARK = [0.62, 0.7, 0.52, 0.6, 0.44, 0.52, 0.32, 0.38, 0.14];
const AREA = [0.72, 0.6, 0.64, 0.46, 0.5, 0.3, 0.34, 0.12];

function chartPoints(data: number[], x: number, y: number, w: number, h: number) {
  const pts: number[] = [];
  data.forEach((v, i) => pts.push(x + (i / (data.length - 1)) * w, y + v * h));
  return pts;
}

function StatView({ layer }: { layer: StatLayer }) {
  const { width: w, height: h } = layer;
  const m = Math.min(w, h);
  const pad = m * 0.14;
  const labelSize = Math.max(10, h * 0.13);
  const valueSize = Math.max(12, h * 0.21);
  const variant = layer.variant || 'sparkline';
  const side = variant === 'check' || variant === 'bars';
  const sideW = side ? Math.min(w * 0.32, h * 0.62) : 0;
  const textW = Math.max(1, w - pad * 2 - sideW);
  const valueY = pad + labelSize * 1.35;
  let graphic: React.ReactNode = null;

  if (variant === 'sparkline' || variant === 'area') {
    const gy = valueY + valueSize * 1.25;
    const gh = Math.max(h * 0.12, h - gy - pad * 0.7);
    const gx = pad;
    const gw = w - pad * 2;
    const pts = chartPoints(variant === 'area' ? AREA : SPARK, gx, gy, gw, gh);
    const lineCol = variant === 'area' ? PALETTE.blue : GREEN;
    const fillCol = variant === 'area' ? PALETTE.blue : PALETTE.mint;
    graphic = (
      <>
        <Line
          points={[...pts, gx + gw, gy + gh, gx, gy + gh]}
          closed
          fill={fillCol}
          opacity={variant === 'area' ? 0.22 : 0.5}
          listening={false}
        />
        <Line
          points={pts}
          stroke={lineCol}
          strokeWidth={Math.max(1.5, m * 0.022)}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      </>
    );
  } else if (variant === 'check') {
    const rr = Math.min(sideW * 0.42, h * 0.24);
    graphic = <CheckBadge cx={w - pad - rr} cy={h / 2} r={rr} />;
  } else if (variant === 'bars') {
    const heights = [0.35, 0.55, 0.45, 0.72, 0.95];
    const bw = sideW / (heights.length * 1.6);
    const bgap = bw * 0.6;
    const maxH = h - pad * 2;
    const x0 = w - pad - (heights.length * bw + (heights.length - 1) * bgap);
    graphic = heights.map((v, i) => (
      <Rect
        key={i}
        x={x0 + i * (bw + bgap)}
        y={h - pad - v * maxH}
        width={bw}
        height={v * maxH}
        cornerRadius={Math.min(bw / 3, 4)}
        fill={PALETTE.blue}
        opacity={0.5 + v * 0.5}
        listening={false}
      />
    ));
  }

  return (
    <>
      <Rect
        width={w}
        height={h}
        cornerRadius={m * 0.12}
        fill="#FFFFFF"
        shadowColor={PALETTE.navy}
        shadowOpacity={0.1}
        shadowBlur={m * 0.08}
        shadowOffsetY={m * 0.02}
        listening={false}
      />
      <Text
        x={pad}
        y={pad}
        width={textW}
        text={layer.label ?? ''}
        fontFamily={FONTS.body}
        fontStyle="500"
        fontSize={labelSize}
        fill={PALETTE.navy}
        opacity={0.8}
        wrap="none"
        ellipsis
        listening={false}
      />
      <Text
        x={pad}
        y={valueY}
        width={textW}
        text={layer.value ?? ''}
        fontFamily={FONTS.body}
        fontStyle="700"
        fontSize={valueSize}
        fill={PALETTE.navy}
        wrap="none"
        ellipsis
        listening={false}
      />
      {graphic}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export interface LayerViewProps {
  layer: Layer;
  detail: Detail;
  interactive?: boolean;
  /** Hide the text while it is being edited inline. */
  hideText?: boolean;
  onMeasured?: (id: string, height: number) => void;
}

/** True when the layer's own pixels define its hit area (no full-box hit rect). */
export function usesPixelHit(layer: Layer): boolean {
  return layer.kind === 'bloom' || layer.kind === 'bgshape';
}

export function LayerView({ layer, detail, interactive, hideText, onMeasured }: LayerViewProps) {
  switch (layer.kind) {
    case 'rect':
      return <Rect width={layer.width} height={layer.height} fill={col(layer.fill)} cornerRadius={layer.cornerRadius ?? 0} listening={false} />;
    case 'text':
      return <TextView layer={layer} hideText={hideText} onMeasured={onMeasured} />;
    case 'button':
      return <ButtonView layer={layer} hideText={hideText} />;
    case 'logo':
      return <LogoView layer={layer} />;
    case 'bloom': {
      const l = layer as BloomLayer;
      return <StretchImage url={assetUrl.bloom(l.shape, l.colour)} w={l.width} h={l.height} flipX={l.flipX} flipY={l.flipY} pixelHit={interactive} />;
    }
    case 'bgshape': {
      const l = layer as BgShapeLayer;
      return <StretchImage url={assetUrl.bg(l.bgId, l.colour)} w={l.width} h={l.height} flipX={l.flipX} flipY={l.flipY} pixelHit={interactive} />;
    }
    case 'charm':
      return <ContainImage url={assetUrl.charm(layer.charm, layer.colour)} w={layer.width} h={layer.height} />;
    case 'image':
      return <ContainImage url={layer.src} w={layer.width} h={layer.height} />;
    case 'photo':
      return <PhotoView layer={layer} detail={detail} />;
    case 'tags':
      return <TagsView layer={layer} />;
    case 'stat':
      return <StatView layer={layer} />;
    default:
      return null;
  }
}
