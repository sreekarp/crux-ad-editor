import { useEffect, useRef, useState } from 'react';
import { SIZES, type SizeKey } from '../brand';
import { brandScore } from '../design';
import type { Issue } from '../types';
import { stageHandle } from './CanvasArea';
import { fixAll, resizeActive } from './copilot';
import { canRedo, canUndo, getActive, useActiveDesign, useEditor } from './store';
import { Button, Icon, IconButton, Segmented } from './ui';

function sizeKeyOf(w: number, h: number): SizeKey | null {
  return (Object.keys(SIZES) as SizeKey[]).find((k) => SIZES[k].width === w && SIZES[k].height === h) ?? null;
}

type ExportFormat = 'png' | 'png2x' | 'jpg';

const fileBase = (name: string) =>
  (name || 'design').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'design';

function download(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Renders the active design from the live stage at exactly design size x scale, with selection/overlays hidden. */
function renderActive(scale: number): Promise<{ canvas: HTMLCanvasElement; name: string } | null> {
  const d = getActive();
  const stage = stageHandle.current;
  if (!d || !stage) return Promise.resolve(null);
  useEditor.getState().set({ selection: [], editingId: null, hoverLayerId: null });
  // Let React drop the selection, then hide overlays and render.
  return new Promise((resolve) =>
    requestAnimationFrame(() => {
      const overlay = stage.findOne('.overlay');
      const wasVisible = overlay?.visible();
      overlay?.visible(false);
      try {
        // Render a hair larger, then draw onto an exact-size canvas so the file is exactly e.g. 1080x1350.
        const W = Math.round(d.width * scale);
        const H = Math.round(d.height * scale);
        const src = stage.toCanvas({ pixelRatio: Math.max(W / stage.width(), H / stage.height()) });
        const out = document.createElement('canvas');
        out.width = W;
        out.height = H;
        const ctx = out.getContext('2d')!;
        ctx.fillStyle = '#ffffff'; // JPG has no transparency
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(src, 0, 0, W, H);
        resolve({ canvas: out, name: d.name });
      } catch (e) {
        console.error(e);
        resolve(null);
      } finally {
        if (overlay && wasVisible !== undefined) overlay.visible(wasVisible);
      }
    }),
  );
}

export async function exportDesign(format: ExportFormat = 'png', suffix = ''): Promise<boolean> {
  const st = useEditor.getState();
  if (!getActive()) {
    st.showToast('Nothing to export yet');
    return false;
  }
  const r = await renderActive(format === 'png2x' ? 2 : 1);
  if (!r) {
    st.showToast('Export failed (an image is cross-origin?)');
    return false;
  }
  const jpg = format === 'jpg';
  const ext = jpg ? 'jpg' : 'png';
  // A batch suffix ("-2") replaces the "(2)" design names already carry, so files aren't numbered twice.
  const base = fileBase(suffix ? r.name.replace(/\s*\(\d+\)\s*$/, '') : r.name);
  download(r.canvas.toDataURL(jpg ? 'image/jpeg' : 'image/png', 0.92), `${base}${suffix}${format === 'png2x' ? '@2x' : ''}.${ext}`);
  st.showToast(`Exported ${r.canvas.width}×${r.canvas.height} ${ext.toUpperCase()}`);
  return true;
}

export function exportPng() {
  void exportDesign('png');
}

/** The editable design itself (layers, slots, brand data) — reopen it later by dropping the file on the canvas. */
export function exportJson() {
  const d = getActive();
  const st = useEditor.getState();
  if (!d) return st.showToast('Nothing to export yet');
  const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
  download(url, `${fileBase(d.name)}.xero.json`);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  st.showToast('Exported editable design file (.json)');
}

/** Every design in the active design's batch (the variations strip), one PNG each. */
export async function exportAllVariations() {
  const st = useEditor.getState();
  const startId = st.activeId;
  const batch = st.batches.find((b) => startId && b.designIds.includes(startId));
  const ids = (batch?.designIds ?? (startId ? [startId] : [])).filter((id) => st.designs.some((d) => d.id === id));
  if (!ids.length) return st.showToast('Nothing to export yet');
  let ok = 0;
  for (let i = 0; i < ids.length; i++) {
    useEditor.getState().setActive(ids[i]);
    await new Promise((r) => setTimeout(r, 1200)); // let the canvas swap designs and load its images
    if (await exportDesign('png', ids.length > 1 ? `-${i + 1}` : '')) ok++;
  }
  if (startId) useEditor.getState().setActive(startId);
  useEditor.getState().showToast(`Exported ${ok} of ${ids.length} variation${ids.length > 1 ? 's' : ''} as PNG`);
}

function ExportMenu({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const items: { label: string; hint: string; run: () => unknown }[] = [
    { label: 'PNG', hint: 'Exact size, e.g. 1080×1350', run: () => exportDesign('png') },
    { label: 'PNG · high-res 2×', hint: 'For print and retina screens', run: () => exportDesign('png2x') },
    { label: 'JPG', hint: 'Smaller file for social posts', run: () => exportDesign('jpg') },
    { label: 'All variations', hint: 'One PNG per design in the strip', run: exportAllVariations },
    { label: 'Design file (.json)', hint: 'Editable layers — reopen later', run: exportJson },
  ];
  return (
    <div className="relative flex" ref={ref}>
      <Button variant="primary" onClick={exportPng} disabled={disabled} className="rounded-r-none">
        <Icon name="download" size={15} /> Export PNG
      </Button>
      <Button
        variant="primary"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="rounded-l-none border-l border-white/20 px-2"
        title="More export options"
        aria-label="More export options"
      >
        <Icon name="chevronDown" size={15} />
      </Button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left hover:bg-slate-50"
              onClick={() => {
                setOpen(false);
                void it.run();
              }}
            >
              <span className="text-sm font-medium text-navy">{it.label}</span>
              <span className="text-[11px] text-slate-400">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function scoreTone(score: number) {
  if (score >= 90) return { ring: 'ring-emerald-300', bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' };
  if (score >= 70) return { ring: 'ring-amber-300', bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' };
  return { ring: 'ring-rose-300', bg: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500' };
}

function BrandBadge() {
  const issues = useEditor((s) => s.issues);
  const design = useActiveDesign();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { apply, set, showToast, select } = useEditor.getState();
  useEffect(() => {
    if (!open) {
      if (useEditor.getState().hoverLayerId) set({ hoverLayerId: null });
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (!design) return null;
  const score = brandScore(issues);
  const tone = scoreTone(score);
  const fixable = issues.filter((i) => i.fix?.length);
  const fixOne = (i: Issue) => {
    if (!i.fix?.length) return;
    apply(i.fix);
    showToast('Fixed: ' + i.message);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-semibold ring-1 ${tone.ring} ${tone.bg} ${tone.text}`}
        title="Brand check"
      >
        <Icon name="shield" size={15} />
        Brand {score}
        {issues.length ? <span className={`rounded-full px-1.5 text-[10px] text-white ${tone.dot}`}>{issues.length}</span> : <Icon name="check" size={14} />}
      </button>
      {open ? (
        <div className="absolute right-0 top-11 z-50 w-96 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-navy">Brand check · {score}/100</div>
              <div className="text-xs text-slate-500">{issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''} · ${fixable.length} auto-fixable` : 'Everything is on-brand'}</div>
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={!fixable.length}
              onClick={() => {
                showToast(fixAll().split('\n')[0]);
              }}
            >
              <Icon name="wand" size={14} /> Fix all
            </Button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {issues.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">No issues found.</div>
            ) : (
              issues.map((i) => (
                <div
                  key={i.id}
                  className="flex cursor-default items-start gap-2.5 border-b border-slate-50 px-4 py-2.5 last:border-0 hover:bg-slate-50"
                  onMouseEnter={() => set({ hoverLayerId: i.layerId ?? null })}
                  onMouseLeave={() => set({ hoverLayerId: null })}
                  onClick={() => i.layerId && select([i.layerId])}
                >
                  <span className={`mt-0.5 ${i.severity === 'error' ? 'text-rose-500' : 'text-amber-500'}`}>
                    <Icon name="alert" size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-snug text-slate-700">{i.message}</div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{i.rule}</div>
                  </div>
                  {i.fix?.length ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        fixOne(i);
                      }}
                    >
                      Fix
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentToggle() {
  const on = useEditor((s) => s.agentMode);
  const setAgentMode = useEditor((s) => s.setAgentMode);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setAgentMode(!on)}
      title="Agent mode: asks when unclear, reviews its own work"
      className={`flex h-9 items-center gap-2 rounded-full px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky/50 ${
        on ? 'bg-navy text-white shadow-sm hover:bg-[#0b1878]' : 'border border-slate-200 bg-white text-slate-600 hover:border-sky hover:text-navy'
      }`}
    >
      <Icon name="sparkle" size={14} className={on ? 'text-sky' : ''} />
      Agent
      <span className={`relative h-4 w-7 rounded-full transition ${on ? 'bg-sky' : 'bg-slate-200'}`} aria-hidden>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

export function TopBar() {
  const design = useActiveDesign();
  const undoable = useEditor(canUndo);
  const redoable = useEditor(canRedo);
  const showSafeZone = useEditor((s) => s.showSafeZone);
  const health = useEditor((s) => s.health);
  const healthInfo = useEditor((s) => s.healthInfo);
  const { undo, redo, set, replace, showToast } = useEditor.getState();
  const key = design ? sizeKeyOf(design.width, design.height) : null;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-navy text-[15px] font-black italic text-sky">x</div>
        <div className="leading-tight">
          <div className="text-[15px] font-bold text-navy">Xero Copilot</div>
          <div className="flex items-center gap-1.5 text-[10px] text-slate-400" title={healthInfo}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                health === 'ok' ? 'bg-emerald-500' : health === 'degraded' ? 'bg-amber-500' : health === 'down' ? 'bg-rose-500' : 'bg-slate-300'
              }`}
            />
            {health === 'ok' ? 'AI online' : health === 'degraded' ? 'AI keys missing' : health === 'down' ? 'AI offline' : 'connecting…'}
          </div>
        </div>
      </div>

      <div className="mx-2 h-6 w-px bg-slate-200" />

      {design ? (
        <input
          className="w-56 truncate rounded-md border border-transparent px-2 py-1 text-sm font-medium text-slate-700 hover:border-slate-200 focus:border-sky focus:outline-none"
          value={design.name}
          onChange={(e) => replace(design.id, { ...design, name: e.target.value }, false)}
          title="Design name"
        />
      ) : (
        <span className="text-sm text-slate-400">No design yet</span>
      )}

      <div className="flex flex-1 items-center justify-center gap-2">
        <Segmented<SizeKey>
          value={key}
          onChange={(k) => {
            const msg = resizeActive(k);
            showToast(msg);
          }}
          options={(Object.keys(SIZES) as SizeKey[]).map((k) => ({ value: k, label: k, title: `${SIZES[k].width}×${SIZES[k].height}` }))}
        />
        <IconButton
          icon="frame"
          title={design && design.height / design.width > 1.7 ? 'Meta 9:16 safe zone' : 'Safe margins'}
          active={showSafeZone}
          onClick={() => set({ showSafeZone: !showSafeZone })}
          disabled={!design}
        />
      </div>

      <AgentToggle />
      <div className="flex items-center gap-1">
        <IconButton icon="undo" title="Undo (Ctrl+Z)" onClick={undo} disabled={!undoable} />
        <IconButton icon="redo" title="Redo (Ctrl+Y)" onClick={redo} disabled={!redoable} />
      </div>
      <BrandBadge />
      <ExportMenu disabled={!design} />
    </header>
  );
}
