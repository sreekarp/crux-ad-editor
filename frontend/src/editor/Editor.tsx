import { useEffect, useState } from 'react';
import { api } from '../api';
import { checkDesign } from '../design';
import { useFontsReady } from '../lib/fonts';
import { loadManifest } from '../lib/manifest';
import { deleteSelected, duplicateSelected, nudgeSelected } from './actions';
import { CanvasArea, SavedStrip, saveCurrentVersion, stageHandle, VariationsStrip } from './CanvasArea';
import { Inspector } from './Inspector';
import { LeftPanel } from './LeftPanel';
import { RightPanel } from './RightPanel';
import { SafeBoundary } from './SafeBoundary';
import { useActiveDesign, useEditor } from './store';
import { TopBar } from './TopBar';
import { exportJson } from './TopBar';
import { Button, Icon, Spinner } from './ui';

// Debug handles (dev only): window.__editor.getState(), window.__stageHandle.current
if (import.meta.env.DEV) Object.assign(window, { __editor: useEditor, __stageHandle: stageHandle });

/** Loads manifest / references / photo bank / health; retries every 15 s while anything is missing. */
function useBackendData() {
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const st = useEditor.getState;
    const tick = async () => {
      const s = st();
      const jobs: Promise<unknown>[] = [];
      jobs.push(
        api
          .health()
          .then((h) => {
            const keys = h.keys ? Object.entries(h.keys).map(([k, v]) => `${k}:${v ? 'ok' : 'missing'}`).join(' ') : '';
            const missing = h.missing?.length ? `Missing API keys: ${h.missing.join(', ')} (backend/.env). ` : '';
            st().set({
              health: !h.ok ? 'down' : h.missing?.length ? 'degraded' : 'ok',
              healthInfo: `${missing}${h.models ? Object.values(h.models).join(' · ') : ''} ${keys}`.trim(),
            });
          })
          .catch((e: Error) => st().set({ health: 'down', healthInfo: e.message })),
      );
      if (!s.manifest) jobs.push(loadManifest(true).then((m) => m && st().set({ manifest: m })));
      if (!s.references.length) jobs.push(api.references().then((r) => Array.isArray(r) && st().set({ references: r })).catch(() => undefined));
      // The bank fills up while the backend generates it: keep refreshing until it looks complete.
      if (s.photos.length < 30) jobs.push(
          api
            .photos()
            .then((p) => Array.isArray(p) && p.length !== st().photos.length && st().set({ photos: p }))
            .catch(() => undefined),
        );
      await Promise.all(jobs);
      if (!alive) return;
      const n = st();
      const missing = !n.manifest || !n.references.length || n.photos.length < 30 || n.health !== 'ok';
      timer = window.setTimeout(tick, missing ? 15_000 : 60_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);
}

/** Debounced brand check of the active design. */
function useBrandCheck() {
  const design = useActiveDesign();
  const manifest = useEditor((s) => s.manifest);
  useEffect(() => {
    if (!design) {
      useEditor.getState().set({ issues: [] });
      return;
    }
    const t = window.setTimeout(() => {
      try {
        useEditor.getState().set({ issues: checkDesign(design, manifest) ?? [] });
      } catch (e) {
        console.warn('[checkDesign]', e);
        useEditor.getState().set({ issues: [] });
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [design, manifest]);
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (isTyping(e)) return;
      if (mod && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.preventDefault();
        s.redo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        duplicateSelected();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selection.length) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === 'Escape') {
        s.set({ selection: [], editingId: null });
      } else if (e.key.startsWith('Arrow') && s.selection.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        nudgeSelected(dx, dy);
      } else if (e.key === 'Enter' && s.selection.length === 1) {
        const d = s.designs.find((x) => x.id === s.activeId);
        const l = d?.layers.find((x) => x.id === s.selection[0]);
        if (l && (l.kind === 'text' || l.kind === 'button') && !l.locked) {
          e.preventDefault();
          s.set({ editingId: l.id });
        }
      }
    };
    // Ctrl+S stars the current design instead of the browser's "save page". Capture phase, so it also works while
    // typing (the on-canvas text editor stops key events from bubbling).
    const onSave = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        saveCurrentVersion();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onSave, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onSave, true);
    };
  }, []);
}

/** A file dropped outside the real drop targets (canvas, chat) must not make the browser open it and wipe the session. */
function useDropGuard() {
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);
}

/** Canvas + the strips under it. The canvas resets its error screen whenever the design changes (undo, restore,
 *  picking another variation); the strips stay outside it so a broken design can still be swapped out. */
function CanvasColumn() {
  const design = useActiveDesign();
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SafeBoundary
        resetKey={design}
        fallback={
          <div className="grid flex-1 place-items-center px-6 text-center text-sm text-rose-600">
            This design failed to render. Press Ctrl+Z, restore a saved version, or pick another variation below.
          </div>
        }
      >
        <CanvasArea />
      </SafeBoundary>
      <VariationsStrip />
      <SavedStrip />
    </div>
  );
}

/** Last-resort screen when the editor chrome itself crashes. Designs are still in memory: offer a retry and a save. */
function CrashScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="grid h-full place-items-center bg-[#F4F6FA] p-6">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-rose-50 text-rose-600">
          <Icon name="alert" size={20} />
        </div>
        <h2 className="text-base font-semibold text-navy">Something broke in the editor</h2>
        <p className="mt-1 text-sm text-slate-500">
          Your designs are still here. Try again first. If it keeps happening, save the current design before reloading — reloading clears
          everything.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
          <Button variant="outline" onClick={exportJson}>
            <Icon name="download" size={14} /> Save current design (.json)
          </Button>
        </div>
      </div>
    </div>
  );
}

function Toast() {
  const toast = useEditor((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-navy px-4 py-2 text-sm font-medium text-white shadow-lg">
      {toast}
    </div>
  );
}

export default function Editor() {
  const fontsReady = useFontsReady();
  const [attempt, setAttempt] = useState(0);
  useBackendData();
  useBrandCheck();
  useShortcuts();
  useDropGuard();

  if (!fontsReady) {
    return (
      <div className="grid h-full place-items-center bg-slate-50 text-sm text-slate-500">
        <span className="flex items-center gap-2">
          <Spinner /> Loading brand fonts…
        </span>
      </div>
    );
  }

  return (
    <SafeBoundary resetKey={attempt} fallback={<CrashScreen onRetry={() => setAttempt((n) => n + 1)} />}>
      <div className="flex h-full flex-col bg-[#F4F6FA] text-slate-800">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <LeftPanel />
          <CanvasColumn />
          <Inspector />
          <RightPanel />
        </div>
        <Toast />
      </div>
    </SafeBoundary>
  );
}
