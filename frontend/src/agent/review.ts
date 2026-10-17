// Agent Mode quality loop (spec §5 + "Settled after builder review"): render each design, score it (brand checker +
// Flash vision critique), apply one fix per round, re-measure and keep the better version. Generates an image only for
// a brief miss (§9: one `photo` op on the hero photo, when the design has requirements; 90 s budget for that round).
// Runs designs in parallel with a 45 s budget each; every step is visible in one live chat message.
// Shape-aware placement: before the first critique (and after every fix) each photo's essential subject region (whole
// head with hair, ...) must be visible inside its shape; code re-fits it, and composes one new photo if it can't fit.
import { api, errorMessage } from '../api';
import { applyOps, brandScore, checkDesign, summarizeDesign } from '../design';
import { headCoverage, subjectCoverage } from '../design/frame';
import { MIN_COVERAGE } from '../design/photoFit';
import { whenImagesIdle } from '../lib/images';
import { cropChanged, focusPropsFromResult, photoFitProps, photoShape, reframeTargets } from '../lib/photoFocus';
import type { Design, Layer, Op, PhotoLayer } from '../types';
import { useEditor } from '../editor/store';
import type { ChatAction } from '../editor/store';
import { agentApi } from './api';
import type { AgentStep, CritiqueResponse, StepThought } from './types';

const S = () => useEditor.getState();

export const PASS_SCORE = 85;
/** Per-design budget, counted from when its photos are ready. */
export const REVIEW_BUDGET_MS = 45_000;
/** A round that regenerates the hero photo (brief miss) gets this much time from its start. */
export const PHOTO_ROUND_MS = 90_000;
const PHOTO_WAIT_MS = 30_000;
const RENDER_TIMEOUT_MS = 15_000;
/** Backend critique budget is 29 s (vision, then its own text fallback): wait for it rather than retrying here. */
const CRITIQUE_TIMEOUT_MS = 32_000;
/** A fix is only applied when there is time to re-score it (render + critique) before the deadline. */
const FIX_MIN_MS = 14_000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)

const clamp100 = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

/** Overall score (§9): the vision score minus brand-checker penalties (8 per error, 3 per warning), clamped 0-100. */
export function combineScore(vision: number, brandErrors = 0, brandWarnings = 0): number {
  const e = Math.max(0, Number(brandErrors) || 0);
  const w = Math.max(0, Number(brandWarnings) || 0);
  return Math.round(clamp100(clamp100(vision) - 8 * e - 3 * w));
}

/** Short trace text for a brief miss: "Photo shows a restaurant owner" -> "restaurant owner missing". */
export function missLabel(miss: string): string {
  const m = (miss ?? '').trim().replace(/[.\s]+$/, '');
  const core = m.replace(/^photo (shows|of)\s+(an?\s+|the\s+)?/i, '');
  const t = clipWords(core, 34);
  return t ? `${t} missing` : 'brief missed';
}

/** Joiner words a shortened line must not end on ("…near the" -> "…"). */
const DANGLING = new Set(
  'a an the and or but nor of to in on at by for with near from into onto over under so that which who is are was its their as than'.split(' '),
);

/** Shortens at a word boundary (never mid-word, no "…"), to at most `max` chars: prefers a clause break (", " "; " " — "
 *  ": ") in the back half, drops an unclosed "(…", dangling joiners and trailing punctuation. A single word longer
 *  than `max` (a URL, say) is the only thing cut hard. */
export function clipWords(s: string, max = 70): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (t.length <= max) return t;
  const head = t.slice(0, max + 1);
  const sp = head.lastIndexOf(' ');
  if (sp <= 0) return t.slice(0, max);
  let cut = head.slice(0, sp);
  const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' — '), cut.lastIndexOf(' - '), cut.lastIndexOf(': '));
  if (clause >= max * 0.5) cut = cut.slice(0, clause);
  const open = cut.lastIndexOf('(');
  if (open > 0 && cut.indexOf(')', open) < 0) cut = cut.slice(0, open);
  const words = cut.replace(/[\s,;:—–(-]+$/, '').split(' ');
  while (words.length > 1 && DANGLING.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) words.pop();
  return words.join(' ').replace(/[\s,;:—–(-]+$/, '');
}

/** "headline is clipped" -> "Headline is clipped". */
export function sentenceCase(s: string): string {
  const t = (s ?? '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
/** "Headline is clipped" -> "headline is clipped"; acronyms ("XERO logo") are left alone. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/** The one allowed image op of a critique (only when the design was checked against requirements). */
export function photoOpOf(ops: Op[] | undefined, allowed: boolean): Extract<Op, { op: 'photo' }> | null {
  if (!allowed) return null;
  return (ops ?? []).find((o): o is Extract<Op, { op: 'photo' }> => o.op === 'photo' && !!o.prompt) ?? null;
}

/** Keep-best: a fix is kept unless it made the score worse. */
export function shouldKeep(before: number, after: number): boolean {
  return after >= before;
}

/** "72 → 88", or just "88" when nothing changed. */
export function scoreDetail(before: number, after: number): string {
  return before === after ? `${after}` : `${before} → ${after}`;
}

export function average(nums: number[]): number {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

/** Next-step chip payload that names the design it was written for: "@@<designId>::<text>". */
export function designPrompt(designId: string, text: string): string {
  return `@@${designId}::${text}`;
}
export function parseDesignPrompt(payload: string): { designId: string | null; text: string } {
  const m = /^@@([^:]+)::([\s\S]*)$/.exec(payload);
  return m ? { designId: m[1], text: m[2] } : { designId: null, text: payload };
}

/** Final trace status: ✓ only at PASS_SCORE+ with every requirement met; otherwise ⚠ "needs work". */
export function finalStatus(score: number | null, briefMisses: string[] = []): 'done' | 'warn' {
  return score !== null && score >= PASS_SCORE && !briefMisses.length ? 'done' : 'warn';
}

const issueWords = (s: string) => new Set((s ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
/** Same problem, possibly reworded by the critic: half the shorter issue's significant words appear in the other. */
export function sameIssue(a: string, b: string): boolean {
  const x = issueWords(a);
  const y = issueWords(b);
  if (!x.size || !y.size) return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size) >= 0.5;
}

/** Issues of the first look that no longer appear in the final critique (= problems actually fixed). */
export function resolvedIssues(before: string[], after: string[]): string[] {
  return (before ?? []).filter((b) => (b ?? '').trim() && !(after ?? []).some((a) => sameIssue(a, b)));
}

/** "headline is clipped by the bloom." -> "Headline is clipped by the bloom": sentence case, no trailing period, shortened
 *  at a word boundary to <= max chars (never cut mid-word, no "…"). For the review message bullets. */
export function shortIssue(s: string, max = 70): string {
  return sentenceCase(clipWords(s, max));
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const TEXT_ROLES: Record<string, string> = {
  headline: 'headline',
  headline2: 'second headline',
  sub: 'sub copy',
  disclaimer: 'disclaimer',
  'row-text': 'checklist text',
};

/** Plain name of a layer for trace text: "sparkle charm", "headline", "button", "photo". */
export function layerLabel(l: Layer | undefined | null, id = ''): string {
  if (!l) {
    const t = id.replace(/[_-]?\d+$/, '').replace(/[_-]+/g, ' ').trim();
    return t || 'layer';
  }
  switch (l.kind) {
    case 'charm':
      return `${l.charm} charm`;
    case 'photo':
      return 'photo';
    case 'text':
      return TEXT_ROLES[l.role ?? ''] ?? 'text';
    case 'button':
      return 'button';
    case 'logo':
      return 'logo';
    case 'bloom':
      return 'bloom';
    case 'bgshape':
      return 'background shape';
    case 'rect':
      return l.role === 'card' ? 'card' : 'shape';
    case 'image':
      return l.role === 'device' ? 'device' : l.role === 'illustration' ? 'illustration' : 'image';
    case 'tags':
      return 'tags strip';
    case 'stat':
      return 'stat card';
    default:
      return 'layer';
  }
}

const SLOT_WORDS: Record<string, string> = {
  headline: 'headline',
  headline2: 'second headline',
  sub: 'sub copy',
  cta: 'button text',
  disclaimer: 'disclaimer',
  items: 'checklist',
  stat: 'stat',
  tags: 'tags',
  hero: 'photo',
  charms: 'charms',
  bloom: 'bloom',
  ctaStyle: 'button style',
  market: 'market',
};
const TEXT_SLOTS = new Set(['headline', 'headline2', 'sub', 'cta', 'disclaimer', 'items']);
const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');

/** One sync op in plain words for the Art Director's thinking: "Moved sparkle charm", "Rebuilt as Card · light",
 *  "Rewrote headline", "Reframed photo". `d` = the design the op was applied to (names the layer). */
export function describeOp(op: Op, d?: Design | null): string {
  const layerOf = (id: string | undefined) => (id ? d?.layers.find((l) => l.id === id) : undefined);
  const name = (id: string | undefined) => layerLabel(layerOf(id), id);
  switch (op.op) {
    case 'reframe':
      return 'Reframed photo';
    case 'photo':
      return 'New photo';
    case 'pixel_edit':
      return `Pixel edit on the ${name(op.id)}`;
    case 'resize':
      return `Resized to ${op.width}×${op.height}`;
    case 'delete':
      return `Removed ${name(op.id)}`;
    case 'add':
      return `Added ${layerLabel(op.layer, op.layer?.id)}`;
    case 'reorder': {
      const n = name(op.id);
      return op.to === 'front' ? `Brought ${n} to the front` : op.to === 'back' ? `Sent ${n} to the back` : `Moved ${n} ${op.to === 'forward' ? 'forward' : 'back'}`;
    }
    case 'rebuild': {
      const s = (op.slots ?? {}) as Record<string, unknown>;
      const keys = Object.keys(s).filter((k) => k !== 'template' && k !== 'colourway' && s[k] !== undefined);
      const words = [...new Set(keys.map((k) => SLOT_WORDS[k] ?? k))];
      if (s.template || s.colourway) {
        const tpl = String(s.template ?? d?.slots?.template ?? '');
        const cw = String(s.colourway ?? d?.slots?.colourway ?? '');
        const as = [cap(tpl), cw].filter(Boolean).join(' · ');
        return `Rebuilt as ${as}${words.length ? ` with new ${and(words)}` : ''}`;
      }
      if (!keys.length) return 'Rebuilt the layout';
      if (keys.every((k) => TEXT_SLOTS.has(k))) return `Rewrote ${and(words)}`;
      if (keys.length === 1 && keys[0] === 'bloom' && typeof s.bloom === 'string') return `Switched bloom to ${s.bloom}`;
      if (keys.length === 1 && keys[0] === 'charms') {
        const list = Array.isArray(s.charms) ? (s.charms as { charm?: string }[]).map((c) => c?.charm).filter(Boolean) : [];
        return list.length ? `Changed charms to ${and(list as string[])}` : 'Removed charms';
      }
      return `Rebuilt with new ${and(words)}`;
    }
    case 'update': {
      const p = (op.props ?? {}) as Record<string, unknown>;
      const has = (...k: string[]) => k.some((x) => x in p);
      const n = name(op.id);
      if (has('mask')) return p.mask ? `Changed photo bloom to ${p.mask}` : 'Removed the photo bloom';
      if (has('charm') && typeof p.charm === 'string') return `Swapped ${n} for a ${p.charm} charm`;
      if (has('hidden')) return `${p.hidden ? 'Hid' : 'Showed'} ${n}`;
      const verbs: string[] = [];
      if (has('text', 'label', 'value', 'items')) verbs.push('Rewrote');
      if (has('src')) verbs.push('Swapped');
      if (has('fill', 'colour', 'textFill', 'pill')) verbs.push('Recoloured');
      if (has('focusX', 'focusY', 'zoom')) verbs.push('Re-cropped');
      if (has('width', 'height', 'fontSize')) verbs.push('Resized');
      if (has('x', 'y')) verbs.push('Moved');
      if (has('rotation')) verbs.push('Rotated');
      if (has('opacity')) verbs.push('Faded');
      if (has('align')) verbs.push('Realigned');
      if (has('fontWeight', 'uppercase', 'letterSpacing', 'lineHeight', 'font', 'cornerRadius')) verbs.push('Restyled');
      if (!verbs.length) return `Adjusted ${n}`;
      return verbs.length > 1 ? `${verbs[0]} and ${verbs[1].toLowerCase()} ${n}` : `${verbs[0]} ${n}`;
    }
    default:
      return 'Changed the design';
  }
}

/** All ops in plain words, in order, without repeats. */
export function describeOps(ops: Op[], d?: Design | null): string[] {
  return [...new Set((ops ?? []).map((o) => describeOp(o, d)).filter(Boolean))];
}

/** Score line for one Art Director look: "Score 72", or "Score 72 · vision 80, brand rules −8" when the checker cost points. */
export function scoreLine(score: number, vision?: number | null): string {
  const pen = typeof vision === 'number' ? Math.round(clamp100(vision)) - score : 0;
  return pen > 0 ? `Score ${score} · vision ${Math.round(clamp100(vision as number))}, brand rules −${pen}` : `Score ${score}`;
}

/** What the review message needs from one design's result. */
export interface SummaryInput {
  before: number | null;
  after: number | null;
  status: 'done' | 'warn' | 'skipped' | 'failed';
  /** What changed for the better, as short actions ("New photo composed for the bloom", "Moved sparkle charm"). */
  fixedItems?: string[];
  openIssues?: string[];
  briefMisses?: string[];
  /** Why it was skipped / failed ("skipped — you edited it", "deleted", "out of time"). */
  note?: string;
  /** No critique came back: the score is the brand checker's alone. */
  brandOnly?: boolean;
}

/** Plain reason a design's review stopped early. */
function stopReason(r: SummaryInput): string {
  const n = (r.note ?? '').toLowerCase();
  if (/deleted/.test(n)) return 'design deleted';
  if (/edited/.test(n)) return 'you edited it';
  if (/out of time/.test(n)) return 'out of time';
  return r.status === 'failed' ? 'review failed' : 'stopped';
}

const SINGLE_MAX = 4;
const MULTI_MAX = 6;

/** Still-open points of a ⚠ design, brief misses first; a ⚠ with nothing named says why it is below the bar. */
function openPoints(r: SummaryInput): string[] {
  // As written (a requirement may start with a proper noun: "Christmas theme visible").
  const misses = (r.briefMisses ?? []).map((m) => `Brief not met: ${clipWords(m, 52)}`);
  const issues = (r.openIssues ?? []).filter((s) => typeof s === 'string' && s.trim());
  const all = [...misses, ...issues];
  return all.length ? all : r.after !== null ? [`Score ${r.after} is below the ${PASS_SCORE} bar`] : [];
}

const uniqueShort = (xs: string[], max: number) => {
  const seen = new Set<string>();
  return xs.map((x) => shortIssue(x)).filter((x) => x && !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase())).slice(0, max);
};

/** The review message text (RichText: "## " lines are section labels, "• " lines bullets).
 *  One design:  "Reviewed 1 design · 72 → 78 · ⚠ needs work" + "## Fixed" + "## Still open" bullets.
 *  Several:     "Reviewed 3 designs · average 74 → 85 · 2 need work" + "## Still open" with "• #2 — headline is 11 words"
 *               (max 6, shared round-robin so every ⚠ design gets a line); per-design detail lives in each card's thinking. */
export function reviewSummary(items: SummaryInput[]): string {
  const n = items.length;
  if (!n) return 'Nothing to review.';
  const scored = items.filter((r) => r.before !== null && r.after !== null);
  const stopped = items.filter((r) => r.status === 'skipped' || r.status === 'failed');
  if (!scored.length) {
    if (stopped.length === n && stopped.every((r) => r.status === 'skipped')) return `Review stopped · ${stopReason(stopped[0])}`;
    return `Review could not score the design${n > 1 ? 's' : ''} (critique unavailable).`;
  }
  const lines: string[] = [];
  if (n === 1) {
    const r = items[0];
    const state =
      r.status === 'done' ? '✓ ready' : r.status === 'warn' ? '⚠ needs work' : `stopped, ${stopReason(r)}`;
    lines.push(
      ['Reviewed 1 design', `${scoreDetail(r.before as number, r.after as number)}${r.brandOnly ? ' (brand rules only)' : ''}`, state].join(' · '),
    );
    const fixed = uniqueShort(r.fixedItems ?? [], SINGLE_MAX);
    if (fixed.length) lines.push('## Fixed', ...fixed.map((x) => `• ${x}`));
    const open = r.status === 'warn' ? uniqueShort(openPoints(r), SINGLE_MAX) : [];
    if (open.length) lines.push('## Still open', ...open.map((x) => `• ${x}`));
    return lines.join('\n');
  }
  const needWork = items.filter((r) => r.status === 'warn').length;
  const avgBefore = average(scored.map((r) => r.before as number));
  const avgAfter = average(scored.map((r) => r.after as number));
  lines.push(
    [
      scored.length === n ? `Reviewed ${n} designs` : `Reviewed ${scored.length} of ${n} designs`,
      `average ${scoreDetail(avgBefore, avgAfter)}`,
      needWork ? `${needWork} need${needWork === 1 ? 's' : ''} work` : stopped.length ? '' : '✓ all ready',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  // Round-robin: each ⚠ design's top point first, then second points, until MULTI_MAX.
  const per = items.map((r) => (r.status === 'warn' ? uniqueShort(openPoints(r), MULTI_MAX) : []));
  const take = per.map(() => 0);
  for (let round = 0, total = 0; total < MULTI_MAX && per.some((p, i) => take[i] < p.length); round++) {
    per.forEach((p, i) => {
      if (total < MULTI_MAX && take[i] === round && round < p.length) {
        take[i]++;
        total++;
      }
    });
  }
  const open = per.flatMap((p, i) => p.slice(0, take[i]).map((x) => `• #${i + 1} — ${lowerFirst(x)}`));
  if (open.length) lines.push('## Still open', ...open);
  const notReviewed = items.flatMap((r, i) => (r.status === 'skipped' || r.status === 'failed' ? [`• #${i + 1} — ${stopReason(r)}`] : []));
  if (notReviewed.length) lines.push('## Not reviewed', ...notReviewed);
  return lines.join('\n');
}

/** "Fix remaining issues" chip for a design that ended ⚠: asks for exactly its still-open issues, on that design. */
export function fixChip(
  r: { id: string; after: number | null; openIssues?: string[]; briefMisses?: string[] },
  index: number,
  several: boolean,
): ChatAction {
  const todo = [
    ...(r.openIssues ?? []).map((s) => s.trim().replace(/[.\s]+$/, '')),
    ...(r.briefMisses ?? []).map((m) => `requirement not met: ${m.trim().replace(/[.\s]+$/, '')}`),
  ].filter(Boolean);
  const text = todo.length
    ? `Edit this design to fix: ${todo.join('; ')}`
    : `Edit this design to fix what keeps it below ${PASS_SCORE}${r.after !== null ? ` (it scored ${r.after})` : ''}`;
  return { label: several ? `Fix #${index + 1}'s issues` : 'Fix remaining issues', kind: 'agent-prompt', payload: designPrompt(r.id, text) };
}

/** Up to n unique suggestions, first-come order, case-insensitive dedupe. */
export function pickSuggestions(lists: string[][], n = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of lists.flat()) {
    const t = (s ?? '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/** Rejects after ms with `${label} timed out`; the timer is always cleared. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out (${Math.round(ms / 1000)}s)`)), Math.max(0, ms));
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------
// Store helpers

const findDesign = (id: string) => S().designs.find((d) => d.id === id) ?? null;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Undo-history signature. Text measurement and photo-status writes change the design object without touching
 *  history; user edits (and undo/redo) always do — so "the user changed it" = design changed AND history changed. */
function histSig(id: string): string {
  const h = S().history[id];
  return h ? `${h.past.length}:${h.future.length}` : '0:0';
}
function histTop(id: string): Design | null {
  const p = S().history[id]?.past;
  return p?.length ? p[p.length - 1] : null;
}

interface Seen {
  design: Design;
  sig: string;
  top: Design | null;
}
const see = (id: string): Seen | null => {
  const design = findDesign(id);
  return design ? { design, sig: histSig(id), top: histTop(id) } : null;
};
/** null = deleted, false = the user edited it, Seen = unchanged (or only system writes; refreshed). */
function stillOurs(id: string, last: Seen): Seen | false | null {
  const now = see(id);
  if (!now) return null;
  const st = S();
  // A slider drag (liveUpdate writes without history until commitGesture) or inline text edit = the user is on it.
  if (st.gestureBase?.id === id || (st.editingId && st.activeId === id)) return false;
  if (now.design === last.design) return now;
  return now.sig === last.sig && now.top === last.top ? now : false;
}

/** Silent swap back to the snapshot, dropping the undo step the fix pushed (when it is still on top). */
function restore(id: string, snapshot: Design) {
  S().replaceDesign(id, snapshot, { history: false });
  const h = S().history[id];
  if (h?.past.length && h.past[h.past.length - 1] === snapshot) {
    S().set({ history: { ...S().history, [id]: { past: h.past.slice(0, -1), future: h.future } } });
  }
}

function sameDesign(a: Design, b: Design): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function waitForPhotos(id: string): Promise<void> {
  const end = Date.now() + PHOTO_WAIT_MS;
  while (Date.now() < end) {
    const d = findDesign(id);
    if (!d || !d.layers.some((l) => l.kind === 'photo' && (l as { status?: string }).status === 'loading')) break;
    await sleep(400);
  }
  try {
    await withTimeout(whenImagesIdle(), 8_000, 'Images');
  } catch {
    /* render anyway */
  }
}

async function render(d: Design): Promise<string | null> {
  try {
    const { renderDesignToDataUrl } = await import('./offscreen');
    return await withTimeout(renderDesignToDataUrl(d, 768), RENDER_TIMEOUT_MS, 'Render');
  } catch (e) {
    console.warn('[review render]', errorMessage(e));
    return null;
  }
}

interface Measure {
  score: number;
  brand: number;
  critique: CritiqueResponse | null;
  /** Brand checker findings (they cost 8 / 3 points each). */
  brandErrors: number;
  brandWarnings: number;
}

/** A bloom-masked photo prefers portrait even in a near-square box: the vertical overflow lets the crop slide the
 *  head down into the visible part of the bloom. */
function orientationFor(layer: { width: number; height: number; mask?: unknown }): 'landscape' | 'square' | 'portrait' {
  const r = layer.width / Math.max(1, layer.height);
  return r > 1.2 ? 'landscape' : r < 0.83 || layer.mask ? 'portrait' : 'square';
}

/** Brand score + critique (vision when a render is available; text-only otherwise — the backend falls back itself).
 *  `mode` pins a re-score to the first look's mode so the two scores are on the same scale. */
async function measure(
  d: Design,
  round: number,
  brief: string | undefined,
  deadline: number,
  mode?: 'vision' | 'text',
  requirements?: string[],
): Promise<Measure> {
  let issues: string[] = [];
  let brand = 100;
  let errorsN = 0;
  let warningsN = 0;
  try {
    const found = checkDesign(d, S().manifest);
    brand = brandScore(found);
    issues = found.map((i) => i.message).slice(0, 8);
    errorsN = found.filter((i) => i.severity === 'error').length;
    warningsN = found.length - errorsN;
  } catch (e) {
    console.warn('[review brand]', e);
  }
  const left = () => deadline - Date.now();
  const image = mode !== 'text' && left() > 10_000 ? await render(d) : null; // near the deadline: text-only critique
  const summary = summarizeDesign(d);
  const hidden = new Set(d.layers.filter((l) => l.hidden).map((l) => l.id));
  if (hidden.size) summary.layers = summary.layers.filter((l) => !hidden.has(l.id)); // not in the image either
  const body = { design: summary, slots: d.slots, brief: brief || undefined, brandIssues: issues, round, ...(requirements?.length ? { requirements } : {}) };
  let critique: CritiqueResponse | null = null;
  try {
    if (left() < 3_000) throw new Error('out of time');
    if (mode === 'vision' && !image) throw new Error('no render for a vision re-score');
    critique = await withTimeout(agentApi.critique(image ? { ...body, image } : body), Math.min(CRITIQUE_TIMEOUT_MS, left()), 'Critique');
  } catch (e) {
    console.warn('[review critique]', errorMessage(e));
  }
  if (critique) {
    const misses = Array.isArray(critique.briefMisses) ? critique.briefMisses.filter((m) => typeof m === 'string' && m.trim()) : [];
    // Contract: any brief miss = verdict fix and vision <= 70 (enforced here too, in case the backend didn't).
    critique = misses.length ? { ...critique, briefMisses: misses, verdict: 'fix', visionScore: Math.min(critique.visionScore, 70) } : { ...critique, briefMisses: [] };
  }
  const score = critique ? combineScore(critique.visionScore, errorsN, warningsN) : brand;
  return { score, brand, critique, brandErrors: errorsN, brandWarnings: warningsN };
}

/** One Art Director look in plain lines: score, issues, brief misses, brand findings, the critic's one-line take. */
export function lookLines(m: { score: number; critique: CritiqueResponse | null; brandErrors?: number; brandWarnings?: number }): string[] {
  const c = m.critique;
  const out = [c ? scoreLine(m.score, c.visionScore) : `Score ${m.score} (brand rules only, vision unavailable)`];
  for (const s of (c?.issues ?? []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 6)) out.push(shortIssue(s, 90));
  const misses = (c?.briefMisses ?? []).filter((x) => typeof x === 'string' && x.trim());
  if (misses.length) out.push(`Missed: ${misses.map((x) => clipWords(x, 60)).join('; ')}`);
  const e = m.brandErrors ?? 0;
  const w = m.brandWarnings ?? 0;
  if (e || w) out.push(`Brand rules: ${[e ? `${e} error${e > 1 ? 's' : ''}` : '', w ? `${w} warning${w > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')}`);
  if (c?.summary?.trim()) out.push(`Take: ${clipWords(c.summary, 90)}`);
  return out;
}

const lookTitle = (k: number, c: CritiqueResponse | null) => `Round ${k} · ${c ? (c.usedVision ? 'vision' : 'text only') : 'brand rules only'}`;

/** The Art Director card's thinking for one design: titled sections, pushed to the card live as they fill. */
interface Thinker {
  open(title: string): void;
  add(...lines: string[]): void;
  /** A line in the "Photo placement" section (opened on first use when the last section is another). */
  photo(line: string): void;
  /** Does the current section already carry a "Decision:" line? */
  decided(): boolean;
}
function thinker(push: (t: StepThought[]) => void): Thinker {
  const sections: StepThought[] = [];
  const flush = () => push(sections.map((s) => ({ title: s.title, lines: [...s.lines] })));
  const last = () => sections[sections.length - 1];
  const add = (...lines: string[]) => {
    const ls = lines.filter(Boolean);
    if (!ls.length) return;
    if (!sections.length) sections.push({ title: 'Notes', lines: [] });
    last().lines.push(...ls);
    flush();
  };
  return {
    open(title) {
      sections.push({ title, lines: [] });
      flush();
    },
    add,
    photo(line) {
      if (last()?.title !== 'Photo placement') sections.push({ title: 'Photo placement', lines: [] });
      add(line);
    },
    decided: () => !!last()?.lines.some((l) => l.startsWith('Decision:')),
  };
}

// ---------------------------------------------------------------------------------------------
// Review loop

export interface ReviewResult {
  id: string;
  before: number | null;
  after: number | null;
  /** Ops applied and kept (a measure of work, not of success). */
  edits: number;
  /** First-look issues / brief misses that the final critique no longer reports. */
  fixed: number;
  /** 'done' = ✓ (>= PASS_SCORE, no brief miss); 'warn' = finished but still needs work. */
  status: 'done' | 'warn' | 'skipped' | 'failed';
  note: string;
  suggestions: string[];
  /** §9: requirements the final version still misses (empty = all met / not checked). */
  briefMisses?: string[];
  /** The critic's last issues for a 'warn' design (what is still open). */
  openIssues?: string[];
  /** Kept changes as short actions, for the review message's "Fixed" list. */
  fixedItems?: string[];
  /** No critique came back: the score is the brand checker's alone. */
  brandOnly?: boolean;
  /** The Art Director card's thinking (rounds, scores, fixes, decisions). */
  thinking?: StepThought[];
}

export interface ReviewOptions {
  /** Fix rounds: 2 for new designs, 1 for edits. */
  rounds: number;
  brief?: string | null;
  /** Reuse this chat message for the trace instead of pushing a new one. */
  msgId?: string;
  /** §9: must-haves per design id (plan.requirements + "Photo shows a <subject>"). Absent = old behaviour. */
  requirements?: Record<string, string[]>;
  /** Edit reviews: each design as it was BEFORE the edit (by id). Shape-aware placement then only touches photos the
   *  edit pushed out of their shape, so a crop the user set by hand survives and an unrelated edit composes no new
   *  photo. Absent = every photo below MIN_COVERAGE is placed (new designs). */
  prev?: Record<string, Design>;
}

/** §9 photo fix: generates the critic's themed photo for the hero layer (orientation of the layer, quality medium).
 *  Returns null on failure / no time. The caller applies it (one undoable step) and re-scores. */
async function generatePhoto(layer: PhotoLayer, prompt: string, deadline: number, design?: Design) {
  const left = deadline - Date.now() - FIX_MIN_MS; // keep time to re-score
  if (left < 5_000) return null;
  try {
    // design: the visible region counts the layers drawn over the photo (card, buttons...).
    return await withTimeout(api.photo({ prompt, orientation: orientationFor(layer), quality: 'medium', ...photoShape(layer, design) }), left, 'Photo');
  } catch (e) {
    console.warn('[review photo]', errorMessage(e));
    return null;
  }
}

/** Where the photo's subject has to fit, for trace text: "bloom" / "frame" / "visible area". */
function shapeWord(layer: PhotoLayer): string {
  const fit = photoShape(layer).fit;
  return fit === 'bloom' ? 'bloom' : fit === 'frame' ? 'frame' : 'visible area';
}
const refitText = (layer: PhotoLayer) => `Re-fitted photo so the whole head is inside the ${shapeWord(layer)}`;
const addFixed = (res: ReviewResult, text: string) => {
  res.fixedItems = [...(res.fixedItems ?? []), text];
};
/** " (subject 94% visible)" for a photo layer of the design as it is now; "" when unknown. */
function visibleNote(designId: string, layerId: string): string {
  const d = findDesign(designId);
  const l = d?.layers.find((x): x is PhotoLayer => x.kind === 'photo' && x.id === layerId);
  if (!d || !l?.subjectBox) return '';
  try {
    return ` (subject ${Math.round(subjectCoverage(l, d) * 100)}% visible)`;
  } catch {
    return '';
  }
}

/** Shape-aware placement (code-measured): every photo whose essential subject region is less than MIN_COVERAGE
 *  visible, plus the `force` ids (critic crop complaints = reframe ops), goes through the fitPhotoLayer ladder
 *  (box-aware crop, then a chunkier bloom). One store write with the given history flag. Photos without a subject
 *  box are never touched. With `prev` (the design before the edit/fix), a photo not in `force` is only placed when its
 *  coverage dropped since `prev` (the change pushed it out), so a hand-set crop stays. Returns the re-fitted layers and
 *  those that still need a new image. */
function refit(id: string, history: boolean, force: string[] = [], prev?: Design): { fitted: PhotoLayer[]; regen: PhotoLayer[] } {
  const out = { fitted: [] as PhotoLayer[], regen: [] as PhotoLayer[] };
  const d = findDesign(id);
  if (!d) return out;
  const ops: Op[] = [];
  for (const l of d.layers) {
    if (l.kind !== 'photo' || l.hidden || !l.subjectBox) continue;
    let cov: number;
    try {
      cov = subjectCoverage(l, d);
    } catch (e) {
      console.warn('[review coverage]', e);
      continue;
    }
    const forced = force.includes(l.id);
    if (cov >= MIN_COVERAGE && !forced) continue;
    const was = prev && !forced ? prev.layers.find((x): x is PhotoLayer => x.kind === 'photo' && x.id === l.id) : undefined;
    try {
      if (was && subjectCoverage(was, prev!) <= cov + 1e-3) continue; // not pushed out by this change: leave the crop
    } catch (e) {
      console.warn('[review coverage]', e);
    }
    const fit = photoFitProps(d, l.id);
    if (!fit) continue;
    if (cropChanged(l, fit.props) && (fit.coverage > cov + 1e-3 || forced)) {
      ops.push({ op: 'update', id: l.id, props: fit.props as Partial<Layer> });
      out.fitted.push(l);
    }
    if (fit.needsRegenerate) out.regen.push(l);
  }
  if (ops.length) {
    const { errors } = S().apply(ops, { designId: id, history });
    if (errors.length) console.warn('[review refit]', errors);
  }
  return out;
}

/** Before the Art Director looks: re-fit photos whose subject is cut by their shape (one undoable step, counts as an
 *  edit); a photo that still can't fit gets one new photo composed for its shape (photo budget), kept only when it
 *  fits at least as well. Returns the deadline to use from here and whether a new photo was tried, or null when the
 *  user stepped in / the design was deleted. */
async function placePhotos(
  id: string,
  deadline: number,
  step: (p: Partial<AgentStep>) => void,
  res: ReviewResult,
  notes: string[],
  think: Thinker,
  prev?: Design,
): Promise<{ deadline: number; composed: boolean } | null> {
  const { fitted, regen } = refit(id, true, [], prev);
  if (fitted.length) {
    res.edits += 1;
    notes.push(refitText(fitted[0]));
    addFixed(res, refitText(fitted[0]));
    think.photo(`Photo: re-fitted so the whole head is inside the ${shapeWord(fitted[0])}${visibleNote(id, fitted[0].id)}`);
    step({ detail: refitText(fitted[0]) });
  }
  const before = see(id);
  if (!before) return null;
  // The layer as it is NOW (after the re-fit, which may have switched its mask): its shape is what the photo is for.
  const layer = regen[0] && before.design.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.id === regen[0].id);
  const prompt = layer ? layer.prompt || before.design.slots?.hero?.photoPrompt : undefined;
  if (!layer || !prompt || !S().agentMode) return { deadline, composed: false };
  const where = shapeWord(layer);
  think.photo(`Photo: no crop keeps the whole subject inside the ${where}, composing a new photo`);
  step({ detail: `composing a new photo for the ${where}…` });
  const img = await generatePhoto(layer, prompt, Math.max(deadline, Date.now() + PHOTO_ROUND_MS), before.design);
  const now = stillOurs(id, before); // the user may have stepped in while the photo was generating
  if (!now) return null;
  const done = { deadline: Math.max(deadline, Date.now() + REVIEW_BUDGET_MS), composed: true }; // the Art Director hasn't looked yet
  const target = now.design.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.id === layer.id);
  if (!img || !target) {
    notes.push(`new photo for the ${where} could not be generated`);
    think.photo(`Photo: a new photo for the ${where} could not be generated, kept the old one`);
    return done;
  }
  const oldCov = subjectCoverage(target, now.design);
  const oldHead = headCoverage(target, now.design);
  const props = { src: img.url, status: 'ready', prompt, ...focusPropsFromResult(target, now.design, img) } as Partial<Layer>;
  if (S().apply([{ op: 'update', id: target.id, props }], { designId: id }).errors.length) return done; // one undoable step
  refit(id, false, [target.id], now.design); // joins the photo's step
  const after = findDesign(id);
  const placed = after?.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.id === target.id);
  // Kept only when it shows at least as much of the head (hair included) AND of its essential region.
  if (!after || !placed || headCoverage(placed, after) < oldHead || subjectCoverage(placed, after) < oldCov) {
    restore(id, now.design);
    notes.push(`new photo fitted the ${where} no better, reverted`);
    think.photo(`Photo: the new photo fitted the ${where} no better, reverted`);
    return done;
  }
  // Keep the slots in step so a later rebuild keeps the new photo (system write: no history).
  if (after.slots?.hero?.type === 'photo') {
    S().replace(id, { ...after, slots: { ...after.slots, hero: { ...after.slots.hero, photoUrl: img.url } } }, false);
  }
  res.edits += 1;
  notes.push(`New photo composed for the ${where}`);
  addFixed(res, `New photo composed for the ${where}`);
  think.photo(`Photo: new photo composed for the ${where}${visibleNote(id, target.id)}`);
  step({ detail: `New photo composed for the ${where}` });
  await waitForPhotos(id);
  return { deadline: Math.max(done.deadline, Date.now() + REVIEW_BUDGET_MS / 2), composed: true };
}

/** Ops that actually change the design, applied in order: a reframe that moves nothing is not an edit. */
function changedOps(d: Design, ops: Op[]): Op[] {
  let cur = d;
  const out: Op[] = [];
  for (const o of ops) {
    try {
      const next = applyOps(cur, [o], S().manifest).design;
      if (!sameDesign(next, cur)) out.push(o);
      cur = next;
    } catch {
      /* no change */
    }
  }
  return out;
}

/** A crop complaint code can't act on: the reframe op changes nothing and the fit ladder finds no better crop or
 *  bloom, so the photo itself must change. Photos with no detected subject are skipped quietly (nothing to aim at). */
function stuckReframe(d: Design | null, ops: Op[]): { id: string; prompt: string } | null {
  if (!d) return null;
  for (const lid of reframeTargets(d, ops)) {
    const l = d.layers.find((x): x is PhotoLayer => x.kind === 'photo' && x.id === lid);
    const prompt = l ? l.prompt || d.slots?.hero?.photoPrompt : undefined;
    if (!l || !prompt || (!l.subject && !l.subjectBox)) continue;
    try {
      const moved = applyOps(d, [{ op: 'reframe', id: lid }], S().manifest).design.layers.find((x) => x.id === lid);
      if (moved?.kind === 'photo' && cropChanged(l, moved)) continue;
      if (cropChanged(l, photoFitProps(d, lid)?.props)) continue;
    } catch {
      continue;
    }
    return { id: lid, prompt };
  }
  return null;
}

async function reviewOne(
  id: string,
  rounds: number,
  brief: string | undefined,
  step: (p: Partial<AgentStep>) => void,
  res: ReviewResult,
  requirements?: string[],
  prev?: Design,
) {
  // The card's thinking: what the Art Director saw, tried and decided, round by round (live).
  const think = thinker((t) => {
    res.thinking = t;
    step({ thinking: t });
  });
  const decide = (text: string) => think.add(`Decision: ${text}`);
  const stoppedBy = (note: string) => (note === 'deleted' ? 'the design was deleted' : 'you edited the design');
  step({ status: 'running', detail: 'waiting for photos…' });
  await waitForPhotos(id);
  let deadline = Date.now() + REVIEW_BUDGET_MS;
  let last = see(id);
  if (!last) {
    res.status = 'skipped';
    res.note = 'deleted';
    return step({ status: 'skipped', detail: 'deleted' });
  }
  if (requirements?.length) {
    think.open('Brief to check');
    think.add(...requirements.map((q) => clipWords(q, 80)));
  }
  // Shape-aware placement before the Art Director looks (code-measured; photos without a subject box are untouched).
  const notes: string[] = [];
  const placed = await placePhotos(id, deadline, step, res, notes, think, prev);
  if (!placed) {
    res.status = 'skipped';
    res.note = findDesign(id) ? 'skipped — you edited it' : 'deleted';
    think.add(`Stopped: ${stoppedBy(res.note)}`);
    return step({ status: 'skipped', detail: res.note });
  }
  deadline = placed.deadline;
  let composed = placed.composed; // at most one new photo per design for placement
  last = see(id) ?? last;
  step({ detail: 'scoring…' });
  let cur = await measure(last.design, 0, brief, deadline, undefined, requirements);
  res.before = res.after = cur.score;
  if (cur.critique?.suggestions?.length) res.suggestions = cur.critique.suggestions;
  if (!cur.critique) {
    res.note = 'vision unavailable — brand score only';
    res.brandOnly = true;
  }
  let look = 1;
  think.open(lookTitle(look, cur.critique));
  think.add(...lookLines(cur));
  const firstMisses = cur.critique?.briefMisses ?? [];
  const firstIssues = (cur.critique?.issues ?? []).filter((s) => typeof s === 'string' && s.trim());
  // Re-scores use the first look's mode: a vision score and a text-only score are not on the same scale.
  const mode = cur.critique ? (cur.critique.usedVision ? 'vision' : 'text') : undefined;
  const allowPhoto = !!requirements?.length;
  for (let r = 1; r <= rounds; r++) {
    const c = cur.critique;
    if (!c) break;
    if (cur.score >= PASS_SCORE) {
      decide(`passes (${cur.score} ≥ ${PASS_SCORE})`);
      break;
    }
    if (c.verdict === 'pass') {
      decide('the critic passed it, nothing to fix');
      break;
    }
    if (!c.ops?.length) {
      decide('no fix suggested');
      break;
    }
    // A photo op (brief miss) gets a round of its own; other ops wait for the next round's critique.
    const briefOp = photoOpOf(c.ops, allowPhoto);
    let ops = briefOp ? [] : c.ops.filter((o) => o.op !== 'photo' && o.op !== 'pixel_edit');
    // A crop complaint no crop or bloom can fix escalates to one new photo composed for the shape (also its own round).
    const stuck = !briefOp && !composed ? stuckReframe(findDesign(id), ops) : null;
    const photoOp: Extract<Op, { op: 'photo' }> | null = briefOp ?? (stuck ? { op: 'photo', id: stuck.id, prompt: stuck.prompt } : null);
    if (stuck) {
      composed = true;
      ops = [];
    }
    if (!photoOp && !ops.length) {
      decide('no fix code can apply');
      break;
    }
    if (photoOp) deadline = Math.max(deadline, Date.now() + PHOTO_ROUND_MS);
    if (deadline - Date.now() < FIX_MIN_MS) {
      notes.push('out of time');
      decide('stopped, out of time');
      break;
    }
    if (!S().agentMode) {
      notes.push('agent mode turned off');
      decide('stopped, agent mode turned off');
      break;
    }
    let now = stillOurs(id, last);
    if (!now) {
      res.status = 'skipped';
      res.note = now === null ? 'deleted' : 'skipped — you edited it';
      decide(`stopped, ${stoppedBy(res.note)}`);
      return step({ status: 'skipped', detail: `${scoreDetail(res.before ?? cur.score, cur.score)} · ${res.note}` });
    }
    const miss = c.briefMisses?.[0];
    let applied = 0;
    let errors: string[] = [];
    let snapshot = now.design;
    let refitNote = '';
    let composedFor = '';
    let kept: string[] = []; // what this round changed, in plain words (the "Fixed" list when kept)
    if (photoOp) {
      const photos = now.design.layers.filter((l): l is PhotoLayer => l.kind === 'photo');
      const layer = photos.find((l) => l.id === photoOp.id) ?? photos[0];
      if (!layer) {
        notes.push('no photo layer to replace');
        decide('stopped, no photo layer to replace');
        break;
      }
      if (stuck) composedFor = shapeWord(layer);
      kept = [composedFor ? `New photo composed for the ${composedFor}` : 'New on-brief photo'];
      think.add(
        stuck
          ? `Fixes: New photo composed for the ${composedFor} (no crop keeps the whole head inside)`
          : `Fixes: New photo (${miss ? missLabel(miss) : 'photo off-brief'})`,
      );
      step({
        detail: stuck
          ? `✗ crop can't keep the whole head inside the ${composedFor} → new photo`
          : `✗ ${miss ? missLabel(miss) : 'photo off-brief'} → new photo`,
      });
      const img = await generatePhoto(layer, photoOp.prompt, deadline, now.design);
      if (!img) {
        notes.push('new photo could not be generated');
        decide('stopped, the new photo could not be generated');
        break;
      }
      now = stillOurs(id, last); // the user may have stepped in while the photo was generating
      if (!now) {
        res.status = 'skipped';
        res.note = now === null ? 'deleted' : 'skipped — you edited it';
        decide(`stopped, ${stoppedBy(res.note)}`);
        return step({ status: 'skipped', detail: res.note });
      }
      snapshot = now.design;
      const target = snapshot.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.id === layer.id);
      if (!target) {
        notes.push('photo layer changed');
        decide('stopped, the photo layer changed');
        break;
      }
      const props = { src: img.url, status: 'ready', prompt: photoOp.prompt, ...focusPropsFromResult(target, snapshot, img) } as Partial<Layer>;
      errors = S().apply([{ op: 'update', id: target.id, props }], { designId: id }).errors; // one undoable step
      applied = errors.length ? 0 : 1;
      if (applied) refit(id, false, [target.id], snapshot); // shape-aware placement joins the photo's step
      // Keep the slots in step so a later rebuild keeps the new photo (system write: no history).
      const after = findDesign(id);
      if (!errors.length && after?.slots?.hero?.type === 'photo') {
        S().replace(id, { ...after, slots: { ...after.slots, hero: { ...after.slots.hero, photoUrl: img.url } } }, false);
      }
      await waitForPhotos(id);
    } else {
      step({ detail: miss ? `✗ ${missLabel(miss)} → fixing…` : `${cur.score} → fixing…` });
      const changed = changedOps(snapshot, ops); // an op is an edit only if it changed something
      applied = changed.length;
      kept = describeOps(changed, snapshot);
      think.add(`Fixes: ${(kept.length ? kept : describeOps(ops, snapshot)).join('; ')}${kept.length ? '' : ' (no visible change)'}`);
      errors = S().apply(ops, { designId: id, autofix: true }).errors;
      // Shape-aware placement after the fix (joins its undo step): crop complaints (reframe ops) go through the fit
      // ladder, and any photo the fix pushed out of its shape is re-fitted.
      const fit = refit(id, false, reframeTargets(snapshot, ops), snapshot);
      if (fit.fitted.length) {
        refitNote = refitText(fit.fitted[0]);
        applied += 1;
        kept.push(refitNote);
        think.add(`Photo: re-fitted so the whole head is inside the ${shapeWord(fit.fitted[0])}${visibleNote(id, fit.fitted[0].id)}`);
      }
    }
    if (errors.length) console.warn('[review ops errors]', errors);
    await sleep(300); // let the canvas measure re-flowed text
    const fixed = see(id);
    if (!fixed) {
      decide('stopped, the design was deleted');
      break;
    }
    if (!applied || sameDesign(fixed.design, snapshot)) {
      // Nothing applied (every op failed, or autofix undid it): put the snapshot back and drop the empty undo step.
      restore(id, snapshot);
      notes.push('fix changed nothing');
      decide('the fix changed nothing, undone');
      break;
    }
    last = fixed;
    const next = await measure(fixed.design, r, brief, deadline, mode, requirements);
    // Every fix is measured before it is kept: no re-score, or one in the other mode, means revert.
    const comparable = !!next.critique && next.critique.usedVision === c.usedVision;
    if (comparable && shouldKeep(cur.score, next.score)) {
      res.edits += applied;
      if (photoOp) notes.push(composedFor ? `New photo composed for the ${composedFor}` : 'new themed photo');
      if (refitNote) notes.push(refitNote);
      if (c.summary) notes.push(c.summary.replace(/[.\s]+$/, '')); // notes are joined with "; "
      kept.forEach((k) => addFixed(res, k));
      decide(`kept (${cur.score} → ${next.score})`);
      cur = next;
      res.after = next.score;
      if (next.critique?.suggestions?.length) res.suggestions = next.critique.suggestions;
      think.open(lookTitle(++look, next.critique));
      think.add(...lookLines(next));
      step({ detail: scoreDetail(res.before ?? next.score, next.score) });
      continue;
    }
    // Worse: revert to the snapshot (silent swap) and drop the now-redundant undo step — unless the user stepped in.
    const back = stillOurs(id, last);
    if (!back) {
      res.status = 'skipped';
      res.note = 'skipped — you edited it';
      decide(`stopped, ${stoppedBy(res.note)}`);
      return step({ status: 'skipped', detail: res.note });
    }
    restore(id, snapshot);
    const what = photoOp ? 'new photo' : 'fix';
    notes.push(
      comparable
        ? `${what} scored ${next.score} < ${cur.score}, reverted`
        : next.critique
          ? `${what} re-scored without the image (not comparable), reverted`
          : `${what} could not be re-scored in time, reverted`,
    );
    decide(
      comparable
        ? `reverted (${what} scored ${next.score} < ${cur.score})`
        : next.critique
          ? `reverted (the re-score was text only, not comparable)`
          : `reverted (no re-score in time)`,
    );
    break;
  }
  const lastMisses = cur.critique?.briefMisses ?? firstMisses;
  res.briefMisses = lastMisses;
  if (lastMisses.length) notes.push(`✗ still missing: ${lastMisses.join(', ')}`);
  else if (firstMisses.length) notes.push(`✓ now has: ${firstMisses.join(', ')}`);
  const lastIssues = (cur.critique?.issues ?? []).filter((s) => typeof s === 'string' && s.trim());
  const resolved = cur.critique ? resolvedIssues(firstIssues, lastIssues) : [];
  const metNow = cur.critique ? firstMisses.filter((m) => !lastMisses.some((x) => sameIssue(x, m))) : [];
  res.fixed = resolved.length + metNow.length;
  metNow.forEach((m) => addFixed(res, `Brief met: ${clipWords(m, 56)}`));
  res.status = finalStatus(res.after ?? cur.score, lastMisses);
  res.openIssues = res.status === 'warn' ? lastIssues.slice(0, 4) : [];
  res.note = [res.note, ...notes].filter(Boolean).join('; ');
  const detail = scoreDetail(res.before ?? cur.score, res.after ?? cur.score);
  if (!think.decided()) {
    const score = res.after ?? cur.score;
    decide(
      !cur.critique
        ? 'no critique came back, brand score only'
        : score >= PASS_SCORE && res.status === 'done'
          ? `passes (${score} ≥ ${PASS_SCORE})`
          : `stopped, ${rounds} fix round${rounds === 1 ? '' : 's'} used`,
    );
  }
  think.open('Result');
  think.add(
    `${detail} · ${res.status === 'done' ? 'ready' : 'needs work'}`,
    ...resolved.slice(0, 4).map((s) => `Resolved: ${lowerFirst(shortIssue(s, 80))}`),
    ...(lastMisses.length ? [`Still missing: ${lastMisses.map((m) => clipWords(m, 60)).join('; ')}`] : []),
  );
  step(res.status === 'done' ? { status: 'done', detail } : { status: 'warn', detail: `${detail} · needs work` });
}

/** Reviews designs in parallel. Never throws; always clears its spinner. Returns per-design results. */
export async function reviewDesigns(ids: string[], opts: ReviewOptions): Promise<ReviewResult[]> {
  const designs = ids.map(findDesign).filter((d): d is Design => !!d);
  if (!designs.length) return [];
  const rounds = Math.max(0, Math.min(2, opts.rounds));
  const brief = opts.brief ?? undefined;
  const n = designs.length;
  const label = (d: Design, i: number) => `#${i + 1} ${(d.name || 'Design').slice(0, 30)}`;
  let steps: AgentStep[] = designs.map((d, i) => ({ id: d.id, label: label(d, i), status: 'pending', role: 'art-director', icon: '◈' }));
  const intro = `Reviewing my work: rendering ${n > 1 ? `all ${n} designs` : 'the design'}, scoring brand rules + a vision check, fixing what scores below ${PASS_SCORE}.`;
  const patch = { text: intro, progress: `Reviewing ${n} design${n > 1 ? 's' : ''}…`, steps };
  const msg = opts.msgId ?? S().pushMsg({ role: 'assistant', ...patch });
  if (opts.msgId) S().updateMsg(msg, patch);

  const results: ReviewResult[] = designs.map((d) => ({
    id: d.id,
    before: null,
    after: null,
    edits: 0,
    fixed: 0,
    status: 'failed',
    note: '',
    suggestions: [],
    fixedItems: [],
  }));
  let finished = false;
  const setStep = (id: string, p: Partial<AgentStep>) => {
    if (finished) return; // a late update must not re-open a closed trace
    steps = steps.map((s) => (s.id === id ? { ...s, ...p } : s));
    S().updateMsg(msg, { steps });
  };

  try {
    const all = Promise.all(
      designs.map(async (d, i) => {
        try {
          await reviewOne(d.id, rounds, brief, (p) => setStep(d.id, p), results[i], opts.requirements?.[d.id], opts.prev?.[d.id]);
        } catch (e) {
          results[i].status = 'failed';
          results[i].note = errorMessage(e);
          setStep(d.id, { status: 'failed', detail: 'review failed' });
        }
      }),
    );
    // Hard cap: photo wait + budget + slack, so the spinner can never hang.
    // Brief-checked designs may spend a 90 s photo round.
    // Any design may also compose one new photo for its shape (placement), with its own photo round.
    const cap = PHOTO_WAIT_MS + REVIEW_BUDGET_MS + 15_000 + PHOTO_ROUND_MS + (opts.requirements ? PHOTO_ROUND_MS : 0);
    await withTimeout(all, cap, 'Review').catch(() => {
      steps = steps.map((s, i) => {
        if (s.status !== 'running' && s.status !== 'pending') return s;
        results[i].status = 'skipped'; // the summary says "out of time" for it (a late finish can't change the text)
        results[i].note = 'out of time';
        return { ...s, status: 'skipped', detail: 'out of time' };
      });
    });
  } finally {
    finished = true;
    // Structured text (RichText): header line, then "## Fixed" / "## Still open" bullets; per-design detail is in
    // each Art Director card's thinking.
    const summary = reviewSummary(
      results.map((r) => ({
        before: r.before,
        after: r.after,
        status: r.status,
        fixedItems: r.fixedItems,
        openIssues: r.openIssues,
        briefMisses: r.briefMisses,
        note: r.note,
        brandOnly: r.brandOnly,
      })),
    );
    const suggestions = pickSuggestions(results.map((r) => r.suggestions));
    // Several designs: each chip carries the design its suggestion was written for (agentPrompt selects it first).
    const source = (s: string) => results.find((r) => r.suggestions.some((x) => (x ?? '').trim().toLowerCase() === s.toLowerCase()))?.id;
    const actions: ChatAction[] = [
      // ⚠ designs first: one "Fix remaining issues" chip each, tagged with its design (agentPrompt selects it).
      ...results.flatMap((r, i): ChatAction[] => (r.status === 'warn' ? [fixChip(r, i, n > 1)] : [])),
      ...suggestions.map((s): ChatAction => {
        const id = n > 1 ? source(s) : undefined;
        return { label: s, kind: 'agent-prompt', payload: id ? designPrompt(id, s) : s };
      }),
      ...(n > 1 ? results.map((r, i): ChatAction => ({ label: `View #${i + 1}${r.after !== null ? ` (${r.after})` : ''}`, kind: 'select-design', payload: r.id })) : []),
    ];
    S().updateMsg(msg, {
      text: summary,
      progress: null,
      steps,
      actions: actions.length ? actions : undefined,
    });
  }
  return results;
}
