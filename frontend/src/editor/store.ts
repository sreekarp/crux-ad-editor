// Editor state (zustand). Every design change goes through applyOps so undo/redo is uniform.
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { applyOps, autoFix } from '../design';
import type { AsyncOp, Design, Issue, Layer, Manifest, Op, PhotoBankItem, PhotoLayer, Reference } from '../types';
import type { AgentQuestion, AgentStep } from '../agent/types';

export interface Batch {
  id: string;
  title: string;
  designIds: string[];
}

export type ChatActionKind =
  | 'recreate-upload'
  | 'four-like-upload'
  | 'fix-all'
  | 'select-design'
  /** Agent mode: payload is a follow-up prompt sent through the agent. */
  | 'agent-prompt'
  /** Agent mode: payload is the id of a pending step the agent is waiting to continue ("Looks right — continue"). */
  | 'agent-continue';

export interface ChatAction {
  label: string;
  kind: ChatActionKind;
  payload?: string;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Epoch ms when the message was posted (stamped by pushMsg). */
  at?: number;
  /** Progress line shown with a spinner ("Writing 4 concepts…"). */
  progress?: string | null;
  error?: boolean;
  actions?: ChatAction[];
  /** Small image preview (uploads). */
  image?: string;
  /** Agent mode: clarifying questions with answer chips. */
  questions?: AgentQuestion[];
  /** Agent mode: the questions were answered (or skipped) and the controls are locked. */
  answered?: boolean;
  /** Agent mode: live checklist (multi-step requests, review trace). */
  steps?: AgentStep[];
}

interface Hist {
  past: Design[];
  future: Design[];
}

/** A design state the user starred to come back to while they keep iterating. */
export interface SavedVersion {
  id: string;
  /** 1-based label ("version 3"); stays stable when other versions are removed. */
  n: number;
  /** The design it was saved from; restoring writes the snapshot back into it. */
  designId: string;
  /** Designs are immutable (every edit makes a new object, like undo history), so this reference is the snapshot. */
  design: Design;
  at: number;
}

/** degraded = the backend is up but some API keys are missing. */
export type Health = 'unknown' | 'ok' | 'degraded' | 'down';
export type LeftTab = 'templates' | 'references' | 'brand';
export type RightTab = 'properties' | 'layers';

const HISTORY_CAP = 60;

export interface EditorState {
  manifest: Manifest | null;
  references: Reference[];
  photos: PhotoBankItem[];
  health: Health;
  healthInfo: string;

  designs: Design[];
  /** Imported files (designId -> flattened PNG preview) for analyze / "4 like this". */
  imports: Record<string, { previewUrl: string; kind: string }>;
  activeId: string | null;
  selection: string[];
  history: Record<string, Hist>;
  batches: Batch[];
  /** Starred versions, oldest first. */
  saved: SavedVersion[];

  issues: Issue[];
  hoverLayerId: string | null;
  editingId: string | null;
  showSafeZone: boolean;
  selectedRefId: string | null;
  leftTab: LeftTab;
  rightTab: RightTab;
  /** Properties / Layers column next to the canvas; collapsed = icon rail. Remembered per browser. */
  inspectorOpen: boolean;

  chat: ChatMsg[];
  busy: boolean;
  toast: string | null;
  /** Agent mode: plan before acting (asks when unclear) and review created designs. Off = classic copilot. */
  agentMode: boolean;

  set: (patch: Partial<EditorState>) => void;
  setAgentMode: (on: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  addDesigns: (designs: Design[], title: string) => void;
  setActive: (id: string) => void;
  select: (ids: string[]) => void;
  /** Apply ops to a design (default: active). history=false for system writes (text measurement, photo status). */
  apply: (
    ops: Op[],
    opts?: { designId?: string; history?: boolean; autofix?: boolean },
  ) => { pending: AsyncOp[]; errors: string[]; fixed: Issue[] };
  /** Replace a design wholesale (copilot results), optionally recording history. */
  replace: (designId: string, design: Design, history?: boolean) => void;
  /** Swap a design by id (works on non-active designs; used by the agent's review to revert a fix).
   *  history true (default) records an undo step like apply; false is a silent swap. */
  replaceDesign: (id: string, design: Design, opts?: { history?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  /** Star the active design as it is now. Returns the existing version when this exact state is already saved. */
  saveVersion: () => SavedVersion | null;
  /** Put a saved version back on the canvas (one undo step) and make its design active. */
  restoreVersion: (id: string) => SavedVersion | null;
  removeSaved: (id: string) => void;
  pushMsg: (msg: Omit<ChatMsg, 'id'>) => string;
  updateMsg: (id: string, patch: Partial<ChatMsg>) => void;
  showToast: (text: string) => void;
  /** Continuous edits (sliders): first call snapshots, commitGesture records one undo step. */
  gestureBase: Design | null;
  beginGesture: () => void;
  commitGesture: () => void;
}

export const uid = (prefix = 'l_') => `${prefix}${nanoid(8)}`;

/**
 * A version saved while a photo was still generating holds that layer as 'loading'; the generation has since
 * finished on the live design, so take the finished photo from there instead of restoring a spinner that never ends.
 */
function withSettledPhotos(snapshot: Design, current: Design): Design {
  if (!snapshot.layers.some((l) => l.kind === 'photo' && l.status === 'loading')) return snapshot;
  return {
    ...snapshot,
    layers: snapshot.layers.map((l) => {
      if (l.kind !== 'photo' || l.status !== 'loading') return l;
      const done = current.layers.find((c): c is PhotoLayer => c.id === l.id && c.kind === 'photo' && c.status !== 'loading');
      return done ? { ...l, src: done.src, status: done.status, subject: done.subject, srcW: done.srcW, srcH: done.srcH } : l;
    }),
  };
}

let toastTimer = 0;

const AGENT_MODE_KEY = 'xero.agentMode';
const INSPECTOR_KEY = 'xero.inspectorOpen';

/** Boolean preference from localStorage ('1' / '0'); fallback when unset or storage is blocked. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* storage blocked: the setting still works for this session */
  }
}

// Keep editor data across Vite HMR re-executions of this module (e.g. while the design engine is being edited).
const hot = import.meta.hot;
const previous = hot?.data?.editorState as Partial<EditorState> | undefined;
const carried: Partial<EditorState> = previous
  ? (Object.fromEntries(Object.entries(previous).filter(([, v]) => typeof v !== 'function')) as Partial<EditorState>)
  : {};

export const useEditor = create<EditorState>()((set, get) => ({
  manifest: null,
  references: [],
  photos: [],
  health: 'unknown',
  healthInfo: '',

  designs: [],
  imports: {},
  activeId: null,
  selection: [],
  history: {},
  batches: [],
  saved: [],

  issues: [],
  hoverLayerId: null,
  editingId: null,
  showSafeZone: false,
  selectedRefId: null,
  leftTab: 'templates',
  rightTab: 'properties',
  inspectorOpen: readFlag(INSPECTOR_KEY, true),

  chat: [
    {
      id: 'welcome',
      role: 'assistant',
      text:
        "Hi! I'm your Xero design copilot. Describe an ad, pick a reference and ask for variations like it, or upload an image, SVG or PSD. Everything I make stays editable and on-brand.",
    },
  ],
  busy: false,
  toast: null,
  agentMode: readFlag(AGENT_MODE_KEY, false),
  gestureBase: null,
  ...carried,

  set: (patch) => set(patch),

  setAgentMode: (on) => {
    writeFlag(AGENT_MODE_KEY, on);
    set({ agentMode: on });
  },

  setInspectorOpen: (open) => {
    writeFlag(INSPECTOR_KEY, open);
    set({ inspectorOpen: open });
  },

  addDesigns: (designs, title) => {
    if (!designs.length) return;
    const batch: Batch = { id: uid('b_'), title, designIds: designs.map((d) => d.id) };
    set((s) => ({
      designs: [...s.designs, ...designs],
      batches: [...s.batches, batch],
      activeId: designs[0].id,
      selection: [],
      editingId: null,
      hoverLayerId: null,
    }));
  },

  setActive: (id) => set({ activeId: id, selection: [], editingId: null, hoverLayerId: null }),

  select: (ids) => set({ selection: ids }),

  apply: (ops, opts = {}) => {
    const s = get();
    const id = opts.designId ?? s.activeId;
    const design = s.designs.find((d) => d.id === id);
    if (!design || !id) return { pending: [], errors: ['no design'], fixed: [] };
    let next: Design;
    let pending: AsyncOp[] = [];
    let errors: string[] = [];
    let fixed: Issue[] = [];
    try {
      const r = applyOps(design, ops, s.manifest);
      next = r.design;
      pending = r.pending ?? [];
      errors = r.errors ?? [];
    } catch (e) {
      console.error('[applyOps]', e);
      return { pending: [], errors: [String(e)], fixed: [] };
    }
    if (opts.autofix) {
      try {
        const f = autoFix(next, s.manifest);
        next = f.design;
        fixed = f.fixed ?? [];
      } catch (e) {
        console.warn('[autoFix]', e);
      }
    }
    get().replace(id, next, opts.history !== false);
    return { pending, errors, fixed };
  },

  replace: (designId, design, history = true) => {
    set((s) => {
      const prev = s.designs.find((d) => d.id === designId);
      if (!prev) return {};
      const designs = s.designs.map((d) => (d.id === designId ? design : d));
      const layerIds = new Set(design.layers.map((l) => l.id));
      const selection = designId === s.activeId ? s.selection.filter((x) => layerIds.has(x)) : s.selection;
      if (!history) return { designs, selection };
      const h = s.history[designId] ?? { past: [], future: [] };
      return {
        designs,
        selection,
        history: { ...s.history, [designId]: { past: [...h.past, prev].slice(-HISTORY_CAP), future: [] } },
      };
    });
  },

  replaceDesign: (id, design, opts = {}) => {
    const s = get();
    if (!s.designs.some((d) => d.id === id)) return;
    const history = opts.history !== false;
    // Same bookkeeping as apply: selection pruned to existing layers, undo step recorded when history is on.
    // The active design's brand check re-runs from the design change (useBrandCheck in Editor.tsx).
    s.replace(id, design, history);
    set((st) => {
      const patch: Partial<EditorState> = {};
      if (id === st.activeId) {
        const layerIds = new Set(design.layers.map((l) => l.id));
        if (st.editingId && !layerIds.has(st.editingId)) patch.editingId = null;
        if (st.hoverLayerId && !layerIds.has(st.hoverLayerId)) patch.hoverLayerId = null;
      }
      return patch;
    });
  },

  undo: () => {
    const s = get();
    const id = s.activeId;
    if (!id) return;
    const h = s.history[id];
    const cur = s.designs.find((d) => d.id === id);
    if (!h || !h.past.length || !cur) return;
    const prev = withSettledPhotos(h.past[h.past.length - 1], cur);
    const ids = new Set(prev.layers.map((l) => l.id));
    set({
      designs: s.designs.map((d) => (d.id === id ? prev : d)),
      history: { ...s.history, [id]: { past: h.past.slice(0, -1), future: [cur, ...h.future] } },
      selection: s.selection.filter((x) => ids.has(x)),
      editingId: null,
    });
  },

  redo: () => {
    const s = get();
    const id = s.activeId;
    if (!id) return;
    const h = s.history[id];
    const cur = s.designs.find((d) => d.id === id);
    if (!h || !h.future.length || !cur) return;
    const next = withSettledPhotos(h.future[0], cur);
    const ids = new Set(next.layers.map((l) => l.id));
    set({
      designs: s.designs.map((d) => (d.id === id ? next : d)),
      history: { ...s.history, [id]: { past: [...h.past, cur], future: h.future.slice(1) } },
      selection: s.selection.filter((x) => ids.has(x)),
      editingId: null,
    });
  },

  saveVersion: () => {
    const s = get();
    const design = s.designs.find((d) => d.id === s.activeId);
    if (!design) return null;
    const existing = s.saved.find((v) => v.design === design);
    if (existing) return existing;
    const v: SavedVersion = {
      id: uid('v_'),
      n: s.saved.reduce((m, x) => Math.max(m, x.n), 0) + 1,
      designId: design.id,
      design,
      at: Date.now(),
    };
    set({ saved: [...s.saved, v] });
    return v;
  },

  restoreVersion: (id) => {
    const s = get();
    const v = s.saved.find((x) => x.id === id);
    const cur = v && s.designs.find((d) => d.id === v.designId);
    if (!v || !cur) return null;
    if (cur !== v.design) s.replaceDesign(v.designId, withSettledPhotos(v.design, cur));
    if (s.activeId !== v.designId) s.setActive(v.designId);
    return v;
  },

  removeSaved: (id) => set((s) => ({ saved: s.saved.filter((v) => v.id !== id) })),

  pushMsg: (msg) => {
    const id = uid('m_');
    set((s) => ({ chat: [...s.chat, { at: Date.now(), ...msg, id }] }));
    return id;
  },

  updateMsg: (id, patch) => set((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),

  beginGesture: () => {
    const s = get();
    if (s.gestureBase) return;
    set({ gestureBase: s.designs.find((d) => d.id === s.activeId) ?? null });
  },

  commitGesture: () => {
    const s = get();
    const base = s.gestureBase;
    if (!base) return;
    const cur = s.designs.find((d) => d.id === base.id);
    if (!cur || cur === base) return set({ gestureBase: null });
    const h = s.history[base.id] ?? { past: [], future: [] };
    set({
      gestureBase: null,
      history: { ...s.history, [base.id]: { past: [...h.past, base].slice(-HISTORY_CAP), future: [] } },
    });
  },

  showToast: (text) => {
    set({ toast: text });
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 2600);
  },
}));

if (hot) {
  hot.dispose((data: Record<string, unknown>) => {
    const s = useEditor.getState();
    // Requests in flight keep writing to the old store instance; don't leave their spinners running forever.
    const chat = s.chat.map((m) => (m.progress ? { ...m, progress: null, text: m.text || 'Interrupted by a code reload — please retry.' } : m));
    data.editorState = { ...s, chat, busy: false, gestureBase: null };
  });
}

// ---------------------------------------------------------------------------------------------
// Selectors / helpers

export const getActive = (s: EditorState = useEditor.getState()): Design | null =>
  s.designs.find((d) => d.id === s.activeId) ?? null;

export const useActiveDesign = () => useEditor((s) => s.designs.find((d) => d.id === s.activeId) ?? null);

export function useSelectedLayer(): Layer | null {
  return useEditor((s) => {
    if (s.selection.length !== 1) return null;
    const d = s.designs.find((x) => x.id === s.activeId);
    return d?.layers.find((l) => l.id === s.selection[0]) ?? null;
  });
}

export const canUndo = (s: EditorState) => !!(s.activeId && s.history[s.activeId]?.past.length);
export const canRedo = (s: EditorState) => !!(s.activeId && s.history[s.activeId]?.future.length);
