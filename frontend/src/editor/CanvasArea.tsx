// Centre panel: the interactive stage (fit to screen) + overlays + inline text editing + variations strip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type Konva from 'konva';
import { Group, Rect, Text, Transformer } from 'react-konva';
import { FONTS, PALETTE, SAFE } from '../brand';
import { DesignStage } from '../canvas/DesignStage';
import { col } from '../canvas/LayerView';
import { ACCEPTED_FILES } from '../import';
import type { ButtonLayer, Design, Layer, TextLayer } from '../types';
import { handleUpload, runChip } from './copilot';
import { SafeBoundary } from './SafeBoundary';
import { useActiveDesign, useEditor } from './store';
import { Icon } from './ui';

/** The live editor stage (used by Export). */
export const stageHandle: { current: Konva.Stage | null } = { current: null };

const RATIO_KINDS = new Set(['logo', 'charm', 'bloom', 'bgshape', 'image']);

function keepRatioFor(l: Layer | undefined): boolean {
  if (!l) return false;
  if (RATIO_KINDS.has(l.kind)) return true;
  if (l.kind === 'photo') return !!l.mask;
  return l.kind === 'text';
}

function anchorsFor(l: Layer | undefined): string[] {
  if (!l || l.locked) return [];
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  if (l.kind === 'text') return [...corners, 'middle-left', 'middle-right'];
  if (keepRatioFor(l)) return corners;
  return [...corners, 'top-center', 'bottom-center', 'middle-left', 'middle-right'];
}

function SelectionTransformer({ design, selection }: { design: Design; selection: string[] }) {
  const ref = useRef<Konva.Transformer>(null);
  const layer = selection.length === 1 ? design.layers.find((l) => l.id === selection[0]) : undefined;
  useEffect(() => {
    const tr = ref.current;
    const stage = tr?.getStage();
    if (!tr || !stage) return;
    const nodes = selection
      .map((id) => stage.findOne((n: Konva.Node) => n.name() === 'layer' && n.id() === id))
      .filter((n): n is Konva.Node => !!n);
    tr.nodes(nodes);
    tr.forceUpdate();
    tr.getLayer()?.batchDraw();
  }, [selection, design]);
  return (
    <Transformer
      ref={ref}
      keepRatio={keepRatioFor(layer)}
      enabledAnchors={anchorsFor(layer)}
      rotateEnabled={!!layer && !layer.locked && layer.kind !== 'logo'}
      resizeEnabled={!layer?.locked}
      flipEnabled={false}
      ignoreStroke
      borderStroke={PALETTE.sky}
      borderStrokeWidth={1.5}
      anchorStroke={PALETTE.sky}
      anchorFill="#FFFFFF"
      anchorSize={9}
      anchorCornerRadius={2}
      rotateAnchorOffset={22}
      padding={2}
      boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 6 || Math.abs(newBox.height) < 6 ? oldBox : newBox)}
    />
  );
}

function SafeZoneOverlay({ design }: { design: Design }) {
  const W = design.width;
  const H = design.height;
  const sw = 2 / 1; // stroke in design px
  const tint = 'rgba(255,113,155,0.16)';
  const is916 = H / W > 1.7;
  if (!is916) {
    const m = SAFE.margin * W;
    return (
      <Rect x={m} y={m} width={W - 2 * m} height={H - 2 * m} stroke={PALETTE.pink} strokeWidth={sw * 2} dash={[14, 10]} listening={false} />
    );
  }
  const st = SAFE.story;
  return (
    <Group listening={false}>
      <Rect x={0} y={0} width={W} height={H * st.top} fill={tint} />
      <Rect x={0} y={H * (1 - st.bottom)} width={W} height={H * st.bottom} fill={tint} />
      <Rect x={0} y={H * st.top} width={W * st.side} height={H * (1 - st.top - st.bottom)} fill={tint} />
      <Rect x={W * (1 - st.side)} y={H * st.top} width={W * st.side} height={H * (1 - st.top - st.bottom)} fill={tint} />
      <Rect x={W * (1 - st.bottomRightW)} y={H * (1 - st.bottomRightH)} width={W * st.bottomRightW} height={H * (st.bottomRightH - st.bottom)} fill={tint} />
      <Rect
        x={W * st.side}
        y={H * st.top}
        width={W * (1 - 2 * st.side)}
        height={H * (1 - st.top - st.bottom)}
        stroke={PALETTE.pink}
        strokeWidth={4}
        dash={[16, 12]}
      />
      <Text x={W * st.side} y={H * st.top * 0.42} text="Meta 9:16 safe zone" fontFamily={FONTS.body} fontStyle="600" fontSize={30} fill="#d6336c" />
    </Group>
  );
}

function Highlight({ layer, scale }: { layer: Layer; scale: number }) {
  return (
    <Rect
      x={layer.x}
      y={layer.y}
      width={layer.width}
      height={layer.height}
      rotation={layer.rotation ?? 0}
      stroke="#FF3B6B"
      strokeWidth={3 / scale}
      dash={[10 / scale, 6 / scale]}
      fill="rgba(255,59,107,0.08)"
      listening={false}
    />
  );
}

function InlineEditor({ layer, scale, onDone }: { layer: TextLayer | ButtonLayer; scale: number; onDone: (text: string | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(layer.text ?? '');
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || layer.kind !== 'text') return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, layer.kind]);
  const isText = layer.kind === 'text';
  const style: CSSProperties = isText
    ? {
        left: layer.x * scale,
        top: layer.y * scale,
        width: layer.width * scale,
        fontFamily: `"${layer.font === 'headline' ? FONTS.headline : FONTS.body}"`,
        fontWeight: layer.fontWeight,
        fontSize: layer.fontSize * scale,
        lineHeight: layer.lineHeight,
        letterSpacing: (layer.letterSpacing ?? 0) * scale,
        color: col(layer.fill, PALETTE.navy),
        textAlign: layer.align,
        textTransform: layer.uppercase ? 'uppercase' : 'none',
        transform: `rotate(${layer.rotation ?? 0}deg)`,
        transformOrigin: 'top left',
      }
    : {
        left: layer.x * scale,
        top: layer.y * scale,
        width: layer.width * scale,
        height: layer.height * scale,
        fontFamily: `"${FONTS.body}"`,
        fontWeight: 700,
        fontSize: layer.fontSize * scale,
        lineHeight: `${layer.height * scale}px`,
        color: col(layer.textFill, PALETTE.navy),
        textAlign: 'center',
        transform: `rotate(${layer.rotation ?? 0}deg)`,
        transformOrigin: 'top left',
      };
  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter' && (!isText || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(value);
        }
      }}
      className="absolute z-20 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-2 outline-offset-2 outline-sky outline-dashed"
      style={style}
    />
  );
}

/** Opens a file through the same path as drag-and-drop: SVG/PSD become editable layers, PNG/JPG/WEBP a flat image,
 *  a design .json reopens as-is. */
function UploadFileButton({ className }: { className: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        title="Open a PNG, JPG, WEBP, SVG, PSD or design .json (SVG and PSD open as editable layers)"
        className={className}
      >
        <Icon name="clip" size={14} />
        Upload file
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUpload(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

function EmptyState() {
  const set = useEditor((s) => s.set);
  return (
    <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-navy text-sky">
        <Icon name="sparkle" size={24} />
      </div>
      <h2 className="text-lg font-semibold text-navy">Start a design</h2>
      <p className="mt-1 text-sm text-slate-500">
        Pick a template, recreate one of the reference ads, describe what you need to the copilot — or drop an image, SVG or PSD here.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button className="rounded-full bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-[#0b1878]" onClick={() => set({ leftTab: 'templates' })}>
          Browse templates
        </button>
        <button className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-navy hover:border-sky" onClick={() => set({ leftTab: 'references' })}>
          Reference ads
        </button>
        <button className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-navy hover:border-sky" onClick={() => void runChip('Variations like this')}>
          Give me concepts
        </button>
        <UploadFileButton className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-navy hover:border-sky" />
      </div>
      <p className="mt-3 text-xs text-slate-400">PNG, JPG, WEBP, SVG, PSD or a saved design .json</p>
    </div>
  );
}

export function VariationsStrip() {
  const activeId = useEditor((s) => s.activeId);
  const batches = useEditor((s) => s.batches);
  const designs = useEditor((s) => s.designs);
  const setActive = useEditor((s) => s.setActive);
  const live = batches.filter((b) => b.designIds.some((id) => designs.some((d) => d.id === id)));
  const batchIdx = live.findIndex((b) => activeId && b.designIds.includes(activeId));
  const batch = batchIdx >= 0 ? live[batchIdx] : null;
  // Shown for a multi-design batch, or whenever there is earlier work to navigate back to.
  if (!batch || (batch.designIds.length < 2 && live.length < 2)) return null;
  const items = batch.designIds.map((id) => designs.find((d) => d.id === id)).filter((d): d is Design => !!d);
  const prev = batchIdx > 0 ? live[batchIdx - 1] : null;
  const next = batchIdx < live.length - 1 ? live[batchIdx + 1] : null;
  const TH = 132;
  return (
    <div className="flex items-center gap-3 border-t border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur">
      <div className="w-32 shrink-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{items.length > 1 ? 'Variations' : 'Design'}</div>
        <div className="line-clamp-2 text-xs text-slate-600" title={batch.title}>
          {batch.title}
        </div>
        {live.length > 1 ? (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
            <button
              type="button"
              disabled={!prev}
              onClick={() => prev && setActive(prev.designIds[0])}
              className="rounded px-1 font-semibold text-slate-500 hover:bg-slate-100 hover:text-navy disabled:opacity-30"
              title="Previous batch"
            >
              ‹
            </button>
            <span className="tabular-nums">
              {batchIdx + 1}/{live.length}
            </span>
            <button
              type="button"
              disabled={!next}
              onClick={() => next && setActive(next.designIds[0])}
              className="rounded px-1 font-semibold text-slate-500 hover:bg-slate-100 hover:text-navy disabled:opacity-30"
              title="Next batch"
            >
              ›
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 gap-3 overflow-x-auto pb-1">
        {items.map((d, i) => {
          const sc = TH / d.height;
          const on = d.id === activeId;
          return (
            <button
              key={d.id}
              onClick={() => setActive(d.id)}
              title={`Edit variation ${i + 1}`}
              className={`group relative shrink-0 overflow-hidden rounded-lg border-2 transition ${
                on ? 'border-sky shadow-md' : 'border-transparent opacity-80 hover:opacity-100 hover:border-slate-300'
              }`}
              style={{ width: d.width * sc + 4, height: TH + 4 }}
            >
              <SafeBoundary fallback={<span className="text-[10px] text-slate-400">preview error</span>}>
                <DesignStage design={d} scale={sc} detail="thumb" />
              </SafeBoundary>
              <span className="absolute left-1 top-1 rounded bg-navy/80 px-1.5 text-[10px] font-semibold text-white">{i + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Height (px) of the strip above the design that holds the floating canvas toolbar. */
const TOOLBAR_H = 36;

const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Star the design on the canvas (button + Ctrl+S). */
export function saveCurrentVersion() {
  const s = useEditor.getState();
  const before = s.saved.length;
  const v = s.saveVersion();
  if (!v) return s.showToast('Nothing to save yet');
  s.showToast(useEditor.getState().saved.length > before ? `Saved as version ${v.n} — it's in the Saved row below the canvas` : `Already saved as version ${v.n}`);
}

function restoreSaved(id: string) {
  const s = useEditor.getState();
  // The copilot writes into designs while it works; swapping one under it would mix the two.
  if (s.busy) return s.showToast('Wait for the copilot to finish, then restore');
  const v = s.saved.find((x) => x.id === id);
  if (!v) return;
  if (s.designs.find((d) => d.id === s.activeId) === v.design) return s.showToast(`Version ${v.n} is already on the canvas`);
  if (s.restoreVersion(id)) s.showToast(`Restored version ${v.n} · Ctrl+Z to undo`);
}

function SaveVersionButton({ design }: { design: Design }) {
  const savedAs = useEditor((s) => s.saved.find((v) => v.design === design));
  return (
    <button
      type="button"
      onClick={saveCurrentVersion}
      title={savedAs ? `This exact design is saved as version ${savedAs.n}` : 'Save this version so you can come back to it (Ctrl+S)'}
      className={`absolute right-4 top-3 z-10 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm ring-1 transition ${
        savedAs ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-white text-navy ring-slate-200 hover:ring-sky'
      }`}
    >
      <Icon name="star" size={14} filled={!!savedAs} className={savedAs ? 'text-amber-500' : ''} />
      {savedAs ? `Saved · version ${savedAs.n}` : 'Save version'}
    </button>
  );
}

/** Starred versions, newest first. Click one to put it back on the canvas. */
export function SavedStrip() {
  const saved = useEditor((s) => s.saved);
  const designs = useEditor((s) => s.designs);
  const busy = useEditor((s) => s.busy);
  const onCanvas = useActiveDesign();
  const removeSaved = useEditor((s) => s.removeSaved);
  if (!saved.length) return null;
  const TH = 84;
  return (
    <div className="flex items-center gap-3 border-t border-slate-200 bg-white/90 px-4 py-1.5 backdrop-blur">
      <div className="w-32 shrink-0">
        <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-600">
          <Icon name="star" size={11} filled /> Saved
        </div>
        <div className="text-xs text-slate-500">{busy ? 'Restore once the copilot finishes' : 'Click one to bring it back'}</div>
      </div>
      <div className="flex min-w-0 flex-1 gap-3 overflow-x-auto px-1 pb-1 pt-2">
        {[...saved].reverse().map((v) => {
          const sc = TH / v.design.height;
          const current = onCanvas === v.design;
          const name = designs.find((d) => d.id === v.designId)?.name ?? v.design.name;
          return (
            <div key={v.id} className="group relative shrink-0">
              <button
                type="button"
                disabled={busy}
                onClick={() => restoreSaved(v.id)}
                title={`Version ${v.n} · ${name} · saved ${timeOf(v.at)}${current ? ' · on the canvas now' : ' — click to restore'}`}
                className={`relative block overflow-hidden rounded-lg border-2 transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  current ? 'border-amber-400 shadow-md' : 'border-transparent hover:border-slate-300'
                }`}
                style={{ width: v.design.width * sc + 4, height: TH + 4 }}
              >
                <SafeBoundary fallback={<span className="text-[10px] text-slate-400">preview error</span>}>
                  <DesignStage design={v.design} scale={sc} detail="thumb" />
                </SafeBoundary>
                <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-navy/80 px-1 text-[10px] font-semibold text-white">
                  <Icon name="star" size={9} filled className="text-amber-300" />
                  {v.n}
                </span>
                {!current && !busy ? (
                  <span className="absolute inset-x-0 bottom-0 bg-navy/85 py-0.5 text-center text-[10px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                    Restore
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => removeSaved(v.id)}
                title="Remove from saved"
                aria-label={`Remove saved version ${v.n}`}
                className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-white text-slate-500 shadow ring-1 ring-slate-200 hover:text-rose-600 group-hover:grid"
              >
                <Icon name="x" size={11} stroke={2.4} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CanvasArea() {
  const design = useActiveDesign();
  const selection = useEditor((s) => s.selection);
  const editingId = useEditor((s) => s.editingId);
  const hoverLayerId = useEditor((s) => s.hoverLayerId);
  const showSafeZone = useEditor((s) => s.showSafeZone);
  const { select, apply, set } = useEditor.getState();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 700 });
  const [dragOver, setDragOver] = useState(false);
  const stageRef = useRef<Konva.Stage | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // TOOLBAR_H keeps a strip above the design for the floating "Save version" button so it never covers the ad.
  const scale = design ? Math.max(0.05, Math.min((box.w - 56) / design.width, (box.h - 56 - TOOLBAR_H) / design.height)) : 1;

  const setStage = (s: Konva.Stage | null) => {
    stageRef.current = s;
    stageHandle.current = s;
  };

  const editingLayer = useMemo(() => {
    const l = design?.layers.find((x) => x.id === editingId);
    return l && (l.kind === 'text' || l.kind === 'button') ? l : null;
  }, [design, editingId]);
  const hoverLayer = design?.layers.find((l) => l.id === hoverLayerId) ?? null;

  const onTransformEnd = (id: string, node: Konva.Node) => {
    const l = design?.layers.find((x) => x.id === id);
    if (!l) return;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    const props: Record<string, unknown> = { x: node.x(), y: node.y(), rotation: node.rotation() };
    if (l.kind === 'text') {
      const uniform = Math.abs(sx - sy) < 0.001 && Math.abs(sy - 1) > 0.001;
      props.width = Math.max(20, l.width * sx);
      if (uniform) {
        props.fontSize = Math.max(6, l.fontSize * sy);
        if (l.letterSpacing) props.letterSpacing = l.letterSpacing * sy;
      }
    } else {
      props.width = Math.max(4, l.width * sx);
      props.height = Math.max(4, l.height * sy);
      if (l.kind === 'button' || l.kind === 'tags') props.fontSize = Math.max(6, l.fontSize * sy);
      if (l.kind === 'button' || l.kind === 'rect') props.cornerRadius = (l.cornerRadius ?? 0) * Math.min(sx, sy);
    }
    apply([{ op: 'update', id, props: props as Partial<Layer> }]);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleUpload(f);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={wrapRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_1px_1px,#d9dee8_1px,transparent_0)] [background-size:18px_18px]"
        style={design ? { paddingTop: TOOLBAR_H } : undefined}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) select([]);
        }}
      >
        {design ? (
          <div className="relative shadow-[0_10px_40px_-12px_rgba(0,8,86,0.35)]" style={{ width: Math.round(design.width * scale), height: Math.round(design.height * scale) }}>
            <DesignStage
              design={design}
              scale={scale}
              interactive
              stageRef={setStage}
              editingId={editingId}
              onLayerDown={(id, shift) => {
                const cur = useEditor.getState().selection;
                if (shift) select(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
                else if (!cur.includes(id)) {
                  select([id]);
                  if (!cur.length) set({ rightTab: 'properties' });
                }
              }}
              onBackgroundDown={() => select([])}
              onLayerDragEnd={(id, node) => apply([{ op: 'update', id, props: { x: node.x(), y: node.y() } }])}
              onLayerTransformEnd={onTransformEnd}
              onLayerDblClick={(id) => {
                const l = design.layers.find((x) => x.id === id);
                if (l && (l.kind === 'text' || l.kind === 'button') && !l.locked) {
                  select([id]);
                  set({ editingId: id });
                }
              }}
              onTextMeasured={(id, h) => apply([{ op: 'update', id, props: { height: h } }], { history: false })}
              overlay={
                <>
                  {showSafeZone ? <SafeZoneOverlay design={design} /> : null}
                  {hoverLayer ? <Highlight layer={hoverLayer} scale={scale} /> : null}
                  {!editingId ? <SelectionTransformer design={design} selection={selection} /> : null}
                </>
              }
            />
            {editingLayer ? (
              <InlineEditor
                key={editingLayer.id}
                layer={editingLayer}
                scale={scale}
                onDone={(text) => {
                  set({ editingId: null });
                  if (text !== null && text !== editingLayer.text) apply([{ op: 'update', id: editingLayer.id, props: { text } }]);
                }}
              />
            ) : null}
          </div>
        ) : (
          <EmptyState />
        )}
        {dragOver ? (
          <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-sky bg-sky/10">
            <div className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-navy shadow">Drop PNG, JPG, SVG or PSD to import</div>
          </div>
        ) : null}
        {design ? (
          <div className="pointer-events-none absolute bottom-3 left-4 rounded-md bg-white/80 px-2 py-1 text-[11px] font-medium text-slate-500 shadow-sm">
            {design.width}×{design.height} · {Math.round(scale * 100)}%
          </div>
        ) : null}
        {design ? (
          <UploadFileButton className="absolute left-4 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-navy shadow-sm ring-1 ring-slate-200 transition hover:ring-sky" />
        ) : null}
        {design ? <SaveVersionButton design={design} /> : null}
      </div>
    </div>
  );
}
