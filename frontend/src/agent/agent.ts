// Agent Mode brain (spec §2–§5d): plan with the LLM, ask when unclear (one round max), act through the existing copilot
// flows, then review the result (review.ts) and offer next steps. Planner down -> the classic regex routing.
// Every step reports in chat; nothing here throws to the UI and `busy` is always reset.
import { api, errorMessage, type AnalyzeResult } from '../api';
import { ACCENT_COLOURS, CORE_COLOURS, FONTS, SIZES, type SizeKey } from '../brand';
import { summarizeDesign } from '../design';
import { subjectCoverage } from '../design/frame';
import { photoShape } from '../lib/photoFocus';
import type { Design, Manifest, PhotoBankItem, PhotoLayer, RuleId, Slots } from '../types';
import { getActive, useEditor } from '../editor/store';
import {
  completeSlots,
  fixAll,
  flatImageOf,
  importPreviewOf,
  recreateReference,
  resizeActive,
  designSubjects,
  runConcepts,
  runEdit,
  runPixelEdit,
  sendMessage,
  sendMessageClassic,
  sizeCommand,
  wantsNewDesigns,
  type ConceptsOutcome,
} from '../editor/copilot';
import { agentApi } from './api';
import { clipWords, parseDesignPrompt, reviewDesigns, withTimeout, type ReviewResult } from './review';
import type { AgentQuestion, AgentStep, PlanAction, PlanContext, PlanResponse, PlanStep, SizeKeyLike, StepAction, StepThought } from './types';

const S = () => useEditor.getState();
const say = (text: string, extra: Partial<Parameters<ReturnType<typeof useEditor.getState>['pushMsg']>[0]> = {}) =>
  S().pushMsg({ role: 'assistant', text, ...extra });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const MAX_COUNT = 8;
/** Pro's output budget is ~4 concepts per call: larger asks are split into calls of at most this many. */
export const CHUNK = 4;
/** Backend plan budget is 26 s (incl. one invalid-JSON retry); agentApi.plan aborts at 30 s. */
const PLAN_TIMEOUT_MS = 28_000;
const ANALYZE_TIMEOUT_MS = 90_000;

const RECREATE = /recreate|rebuild|on-brand|editable/i;
// Wider than the classic router's: "make variations like it" (the import message's own wording), "in this style", "versions".
const LIKE = /\blike (this|that|it|these)\b|similar|same (style|look|vibe)|in (this|that) style|variations?|versions?|alternatives/i;

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)

const ACTIONS: PlanAction[] = ['ask', 'create', 'edit', 'recreate', 'variations', 'resize', 'fix', 'chat', 'steps'];
const STEP_ACTIONS: StepAction[] = ['edit', 'resize', 'fix'];
const SIZE_KEYS: SizeKeyLike[] = ['4:5', '1:1', '9:16'];
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function clampCount(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(MAX_COUNT, v)) : 1;
}

/** Balanced concept calls of at most `max` designs: 4 -> [4], 6 -> [3, 3], 7 -> [4, 3], 8 -> [4, 4]. */
export function chunkCounts(n: number, max = CHUNK): number[] {
  const total = clampCount(n);
  const k = Math.ceil(total / max);
  const base = Math.floor(total / k);
  return Array.from({ length: k }, (_, i) => base + (i < total % k ? 1 : 0));
}

/** Size named anywhere in a step ("Make it a 9:16 story" / "square"). */
export function sizeKeyIn(text: string): SizeKey | null {
  const t = text.toLowerCase();
  if (/9:16|\bstor(y|ies)\b|\breels?\b|\bvertical\b/.test(t)) return '9:16';
  if (/1:1|\bsquare\b/.test(t)) return '1:1';
  if (/4:5|\bportrait\b|\bfeed\b/.test(t)) return '4:5';
  return null;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);

/** Max 3 questions, 2-4 unique options each, unique slug ids. Invalid questions are dropped. */
export function normalizeQuestions(raw: unknown): AgentQuestion[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: AgentQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const text = str((q as AgentQuestion).q);
    const opts = Array.isArray((q as AgentQuestion).options) ? (q as AgentQuestion).options.map(str).filter(Boolean) : [];
    const options = [...new Set(opts)].slice(0, 4);
    if (!text || options.length < 2) continue;
    let id = slug(str((q as AgentQuestion).id) || text) || `q${out.length + 1}`;
    while (ids.has(id)) id = `${id}_${out.length + 1}`;
    ids.add(id);
    out.push({ id, q: text, options, ...((q as AgentQuestion).multi === true ? { multi: true } : {}) });
    if (out.length >= 3) break;
  }
  return out;
}

export function normalizeSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is PlanStep => !!s && typeof s === 'object' && STEP_ACTIONS.includes((s as PlanStep).action))
    .map((s) => {
      const prompt = str(s.prompt) || (s.action === 'fix' ? 'Fix brand issues' : '');
      return { action: s.action, prompt, label: str(s.label) || prompt };
    })
    .filter((s) => s.prompt)
    .slice(0, 5);
}

/** Client-side plan guard (mirrors the backend): never ask twice, never ask without questions, never edit without a
 *  design, 'steps' needs 2+ valid steps, count 1-8, resize needs a size. */
export function normalizePlan(raw: Partial<PlanResponse> | null | undefined, ctx: { message: string; hasDesign: boolean; askedAlready: boolean }): PlanResponse {
  const r = raw ?? {};
  const message = ctx.message.trim();
  const fallback: PlanAction = !ctx.hasDesign || wantsNewDesigns(message) ? 'create' : 'edit';
  let action: PlanAction = ACTIONS.includes(r.action as PlanAction) ? (r.action as PlanAction) : fallback;
  let prompt = str(r.prompt) || message;
  const questions = normalizeQuestions(r.questions);
  if (action === 'ask' && (ctx.askedAlready || !questions.length)) action = fallback;
  const steps = normalizeSteps(r.steps);
  if (action === 'steps' && steps.length < 2) {
    if (steps.length) prompt = steps[0].prompt;
    action = 'edit';
  }
  if (!ctx.hasDesign && (action === 'edit' || action === 'resize' || action === 'fix' || action === 'steps')) action = 'create';
  let size: SizeKeyLike | null = SIZE_KEYS.includes(r.size as SizeKeyLike) ? (r.size as SizeKeyLike) : null;
  if (action === 'resize' && !size) {
    size = sizeCommand(message) ?? sizeKeyIn(prompt);
    if (!size) action = 'edit';
  }
  const subjects = Array.isArray(r.subjects) ? r.subjects.map(str).filter(Boolean) : [];
  // The backend count wins ("which businesses?" -> count = number picked); missing count -> one design per subject.
  const count = clampCount(r.count ?? (subjects.length || 1));
  return {
    understanding: str(r.understanding) || message,
    action,
    questions: action === 'ask' ? questions : [],
    prompt,
    brief: str(r.brief) || null,
    count,
    size,
    steps: action === 'steps' ? steps : [],
    reply: str(r.reply),
    subjects: subjects.slice(0, count),
    theme: str(r.theme) || null,
    requirements: Array.isArray(r.requirements) ? r.requirements.map(str).filter(Boolean).slice(0, 6) : [],
  };
}

/** Per-design must-haves for the Art Director: the plan's requirements + design i's own subject (by creation order). */
export function designRequirements(ids: string[], subjects: string[] = [], requirements: string[] = []): Record<string, string[]> {
  return Object.fromEntries(
    ids.map((id, i) => {
      const subject = str(subjects[i]);
      const own = subject ? [`Photo shows ${/^[aeiou]/i.test(subject) ? 'an' : 'a'} ${subject}`] : [];
      return [id, [...requirements, ...own]];
    }),
  );
}

const humanize = (id: string) => {
  const t = id.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Answers echoed as one user line: "Audience: Cafés · Offer: 3 months free · How many: 2". */
export function formatAnswers(answers: Record<string, string>, questions: AgentQuestion[] = []): string {
  return Object.entries(answers)
    .filter(([, a]) => str(a))
    .map(([q, a]) => {
      const match = questions.find((x) => x.q === q || x.id === q);
      const label = match ? (/business/i.test(`${match.id} ${match.q}`) ? 'Businesses' : humanize(match.id)) : q.replace(/\?\s*$/, '');
      return `${label}: ${str(a)}`;
    })
    .join(' · ');
}

/** Message + answers as one line for the classic router (planner-down fallback). */
export function withAnswers(message: string, answers: Record<string, string> | null, questions: AgentQuestion[] = []): string {
  // A bare count ("3") gets a noun so the classic router's countFor() reads it: "Count: 3 designs".
  const named = answers ? Object.fromEntries(Object.entries(answers).map(([q, v]) => [q, /^[1-8]$/.test(str(v)) ? `${str(v)} designs` : v])) : null;
  const a = named ? formatAnswers(named, questions) : '';
  return a ? `${message.replace(/[.!\s]+$/, '')}. ${a}` : message;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "What I see" playback of an /api/analyze result (only what was actually detected, no defaults). */
export function describeAnalysis(s: Partial<Slots>, texts: string[] = []): string {
  const parts: string[] = [];
  if (s.template) parts.push(`${s.template} layout`);
  if (s.colourway) parts.push(`${s.colourway} colourway`);
  const hero = s.hero;
  if (hero?.type === 'photo') parts.push(hero.photoTag ? `${hero.photoTag} photo` : 'a photo');
  else if (hero?.type === 'device') parts.push('a device mock-up');
  else if (hero?.type === 'illustration') parts.push('an illustration');
  const headline = s.headline || texts[0];
  if (headline) parts.push(`headline "${clip(headline, 70)}"`);
  if (s.cta) parts.push(`button "${clip(s.cta, 30)}"`);
  const charms = s.charms ?? [];
  if (charms.length) parts.push(`${charms.length} charm${charms.length > 1 ? 's' : ''} (${charms.map((c) => c.charm).join(', ')})`);
  return parts.length ? `I see: ${parts.join(', ')}.` : "I see an image, but I couldn't pick out its layout.";
}

/** Brief addition for later concept chunks so they don't repeat the first chunk. */
export function avoidBrief(made: Partial<Slots>[]): string {
  const items = made
    .filter((s) => s && (s.template || s.headline))
    .map((s) => `${s.template ?? 'design'} "${clip(s.headline ?? '', 60)}"`);
  return items.length
    ? `Other concepts in this set already use: ${items.join('; ')}. Use different templates, headlines and copy angles.`
    : '';
}

// ---------------------------------------------------------------------------------------------
// Card thinking (click a card to see what that role saw, decided and why). Short plain lines, no JSON.

/** Every rule the brand checker enforces (typed: a new RuleId must be listed here or tsc fails). */
const BRAND_RULES: Record<RuleId, true> = {
  palette: true,
  'text-colour': true,
  contrast: true,
  'logo-count': true,
  'logo-colour': true,
  'logo-pill': true,
  'logo-aspect': true,
  'cta-count': true,
  'headline-length': true,
  'headline-punctuation': true,
  'safe-margin': true,
  'safe-zone-916': true,
  'min-font-size': true,
  disclaimer: true,
  'photo-treatment': true,
  'bloom-colours': true,
  aspect: true,
  'off-canvas': true,
};

/** Brand Kit card: what every design is built from (static brand facts + asset counts once the manifest is in). */
export function brandKitThinking(manifest: Manifest | null, photos = 0): StepThought[] {
  const lines = [
    `Palette: ${CORE_COLOURS.join(', ')} + ${ACCENT_COLOURS.length} bloom accents`,
    `Fonts: ${FONTS.headline} / ${FONTS.body}`,
    `Rules: ${Object.keys(BRAND_RULES).length} brand rules, checked on every design`,
  ];
  if (manifest) {
    const charms = new Set((manifest.charms ?? []).map((c) => c.type)).size;
    const blooms = new Set((manifest.blooms ?? []).map((b) => b.shape)).size;
    lines.push(`Assets: ${charms} charms, ${blooms} blooms, ${photos} photos`);
  }
  return [{ title: 'Loaded', lines }];
}

/** Colourway the user asked for in so many words ("dark version", "make it light"); null = not named. */
export function lookOf(text: string): 'light' | 'dark' | 'blue' | null {
  const t = (text ?? '').toLowerCase();
  const m =
    /\b(dark|light|blue)\s+(colou?rway|version|theme|mode|background|look|design|ad)s?\b/.exec(t) ??
    /\b(?:make it|go|in|use|keep it)\s+(?:the\s+)?(dark|light|blue)\b/.exec(t);
  return m ? (m[1] as 'light' | 'dark' | 'blue') : null;
}

/** "create · 3 designs · 9:16", "steps · 3 steps", "resize · 9:16", "ask · 2 questions". */
function actionLine(plan: PlanResponse): string {
  const n = plan.count;
  const parts: string[] = [plan.action];
  if (plan.action === 'create' || plan.action === 'variations') parts.push(`${n} design${n > 1 ? 's' : ''}`);
  if (plan.action === 'steps') parts.push(`${plan.steps.length} steps`);
  if (plan.action === 'ask') parts.push(`${plan.questions.length} question${plan.questions.length > 1 ? 's' : ''}`);
  if (plan.size) parts.push(plan.size);
  return parts.join(' · ');
}

/** "Asked: Who is it for? → Tradies" lines for the question round before this plan (answers: question text -> answer;
 *  "Reply" = one typed answer to several questions; empty = "Just go"). */
export function askedLines(answers: Record<string, string> | null | undefined, questions: AgentQuestion[] = []): string[] {
  if (!questions.length && !answers) return [];
  const entries = Object.entries(answers ?? {}).filter(([, a]) => str(a));
  if (!entries.length) return questions.length ? [`Asked: ${questions.map((q) => q.q).join(' / ')} → you said "just go", so I used my best guess`] : [];
  return entries.map(([q, a]) => {
    const asked = q === 'Reply' && questions.length ? questions.map((x) => x.q).join(' / ') : (questions.find((x) => x.id === q)?.q ?? q);
    return `Asked: ${clipWords(asked, 80)} → ${clipWords(str(a), 80)}`;
  });
}

/** Strategist card: what was understood, the plan, the look/theme/subjects, must-haves, the question round, the hand-off. */
export function strategistThinking(
  plan: PlanResponse,
  ctx: { message?: string; answers?: Record<string, string> | null; questions?: AgentQuestion[] } = {},
): StepThought[] {
  const brief = [`Understood: ${clipWords(plan.understanding, 140)}`, `Action: ${actionLine(plan)}`];
  const look = lookOf(`${ctx.message ?? ''} ${plan.prompt} ${plan.brief ?? ''}`);
  if (look) brief.push(`Look: ${look} colourway`);
  if (plan.theme) brief.push(`Theme: ${plan.theme}`);
  if (plan.subjects.length) brief.push(`Subjects: ${plan.subjects.join(', ')}`);
  const out: StepThought[] = [{ title: 'Brief', lines: brief }];
  if (plan.requirements.length) out.push({ title: 'Requirements', lines: plan.requirements.map((r) => clipWords(r, 90)) });
  const asked = askedLines(ctx.answers, ctx.questions);
  if (plan.action === 'ask') out.push({ title: 'Questions', lines: plan.questions.map((q) => `Asking: ${q.q} (${q.options.join(' / ')})`) });
  else if (asked.length) out.push({ title: 'Questions', lines: asked });
  if (plan.action === 'steps') out.push({ title: 'Steps', lines: plan.steps.map((s, i) => `${i + 1}. ${clipWords(s.label || s.prompt, 80)}`) });
  const handoff: string[] = [];
  if (plan.action === 'chat') handoff.push(`Reply: ${clipWords(plan.reply || plan.understanding, 140)}`);
  else if (plan.action !== 'ask' && plan.action !== 'steps') {
    handoff.push(`Brief to Producer: ${clipWords(plan.prompt, 140)}`);
    if (plan.brief) handoff.push(`Facts: ${clipWords(plan.brief, 140)}`);
  }
  if (handoff.length) out.push({ title: 'Hand-off', lines: handoff });
  return out;
}

const capWord = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const FIT_WORD = { bloom: 'bloom', frame: 'frame', full: 'full frame' } as const;

/** One Producer section per built design: "#1 Card · light" — copy, photo source and fit, visible subject, bloom swap. */
export function producerSection(
  index: number,
  design: Design | null | undefined,
  made: { slots?: Slots; subject?: string } | undefined,
  ctx: { bank?: PhotoBankItem[]; fallback?: boolean } = {},
): StepThought {
  const s: Partial<Slots> = made?.slots ?? design?.slots ?? {};
  const title = [`#${index + 1}`, [capWord(s.template ?? ''), s.colourway ?? ''].filter(Boolean).join(' · ')].filter(Boolean).join(' ');
  const lines: string[] = [];
  if (s.headline) lines.push(`Headline "${clipWords(s.headline, 80)}"`);
  if (s.headline2) lines.push(`Second headline "${clipWords(s.headline2, 80)}"`);
  if (s.sub) lines.push(`Sub "${clipWords(s.sub, 80)}"`);
  if (s.items?.length) lines.push(`Checklist: ${s.items.map((x) => clipWords(x, 40)).join('; ')}`);
  if (s.stat) lines.push(`Stat: ${s.stat.label} ${s.stat.value}`);
  if (s.cta) lines.push(`Button "${clipWords(s.cta, 40)}"`);
  if (made?.subject) lines.push(`Written for: ${made.subject}`);
  const layers = design?.layers ?? [];
  const photo = (layers.find((l) => l.kind === 'photo' && l.role === 'photo') ?? layers.find((l) => l.kind === 'photo')) as PhotoLayer | undefined;
  if (photo) {
    const bank = photo.src ? (ctx.bank ?? []).find((p) => p.url === photo.src) : undefined;
    if (!photo.src) lines.push(photo.status === 'error' ? 'Photo: could not be loaded' : 'Photo: not ready yet');
    else if (bank || /\/static\/gen\/bank\//.test(photo.src))
      lines.push(`Photo: bank${bank?.tag ? ` (${bank.tag})` : ''}${ctx.fallback ? ', generating one failed' : ''}`);
    else lines.push(`Photo: generated, composed for the ${FIT_WORD[photoShape(photo, design ?? undefined).fit ?? 'full']}`);
    if (photo.src && photo.subjectBox && design) {
      try {
        lines.push(`Subject visible: ${Math.round(subjectCoverage(photo, design) * 100)}%`);
      } catch {
        /* unknown */
      }
    }
    if (s.bloom && photo.mask && s.bloom !== photo.mask) lines.push(`Bloom: ${s.bloom} → ${photo.mask} (better fit)`);
  } else if (s.hero?.type === 'device') lines.push(`Hero: device mock-up${s.hero.deviceId ? ` (${s.hero.deviceId})` : ''}`);
  else if (s.hero?.type === 'illustration') lines.push('Hero: illustration');
  const charms = (s.charms ?? []).map((c) => c.charm).filter(Boolean);
  if (charms.length) lines.push(`Charms: ${charms.join(', ')}`);
  return { title, lines };
}

/** What createDesigns built, for the Producer card. */
export interface Built {
  ids: string[];
  made: ConceptsOutcome['designs'];
  fallback: string[];
  errors: string[];
  chunks?: number[];
}

/** Producer card: one section per design (creation order = the Art Director's #1, #2…), then batch notes / errors. */
export function producerThinking(b: Built, designs: Design[], bank: PhotoBankItem[] = []): StepThought[] {
  const out = b.ids.map((id, i) =>
    producerSection(
      i,
      designs.find((d) => d.id === id),
      b.made.find((m) => m.id === id),
      { bank, fallback: b.fallback.includes(id) },
    ),
  );
  const notes: string[] = [];
  if (b.chunks && b.chunks.length > 1) notes.push(`Batches: ${b.chunks.join(' + ')}, later batches avoid the first batch's ideas`);
  for (const e of b.errors) notes.push(`A batch failed: ${clipWords(e, 100)}`);
  if (notes.length) out.push({ title: 'Notes', lines: notes });
  return out;
}

// ---------------------------------------------------------------------------------------------
// State: one open question round / "what I see" confirmation at a time (keyed by chat message id)

interface PendingAsk {
  message: string;
  questions: AgentQuestion[];
}
interface PendingSee {
  kind: 'recreate' | 'variations';
  slots: Slots;
  texts: string[];
  plan: PlanResponse;
  preview: string;
}
const asks = new Map<string, PendingAsk>();
const sees = new Map<string, PendingSee>();

/** A typed message right after a question round / "what I see" is the answer / correction. Older ones expire. */
function openPending(): { type: 'ask' | 'see'; id: string } | null {
  const recent = new Set(S().chat.slice(-4).map((m) => m.id));
  let found: { type: 'ask' | 'see'; id: string } | null = null;
  for (const id of [...asks.keys()]) {
    if (recent.has(id)) found = { type: 'ask', id };
    else {
      asks.delete(id);
      S().updateMsg(id, { answered: true });
    }
  }
  for (const id of [...sees.keys()]) {
    if (recent.has(id)) found = { type: 'see', id };
    else {
      sees.delete(id);
      S().updateMsg(id, { actions: undefined });
    }
  }
  return found;
}

function historyFor(message: string): PlanRequestHistory {
  const msgs = S().chat.filter((m) => m.id !== 'welcome' && !m.progress && m.text);
  const last = msgs[msgs.length - 1];
  const trimmed = last && last.role === 'user' && last.text.trim() === message.trim() ? msgs.slice(0, -1) : msgs;
  return trimmed.slice(-6).map((m) => ({ role: m.role, content: m.text }));
}
type PlanRequestHistory = { role: 'user' | 'assistant'; content: string }[];

// ---------------------------------------------------------------------------------------------
// Acting

const ids = () => new Set(S().designs.map((d) => d.id));

/** Runs fn, then reviews what it produced: new designs (newRounds) or a changed active design (editRounds). */
async function reviewAfter(
  fn: () => unknown,
  opts: { newRounds?: number; editRounds?: number; brief?: string | null } = {},
): Promise<ReviewResult[]> {
  const before = ids();
  const active = getActive();
  await fn();
  if (!S().agentMode) return []; // switched off while it ran: no review
  const created = S().designs.filter((d) => !before.has(d.id)).map((d) => d.id);
  if (created.length) return reviewDesigns(created, { rounds: opts.newRounds ?? 2, brief: opts.brief });
  const now = active ? S().designs.find((d) => d.id === active.id) : null;
  // prev: photo placement only touches photos this edit pushed out of their shape (hand-set crops stay).
  if (active && now && now !== active) return reviewDesigns([active.id], { rounds: opts.editRounds ?? 1, brief: opts.brief, prev: { [active.id]: active } });
  return [];
}

/** Chip / classic flows in agent mode: same flow, then the quality loop (new designs: 2 rounds, edits: 1). */
export async function withAgentReview(fn: () => unknown, opts: { newRounds?: number; editRounds?: number; brief?: string | null } = {}) {
  if (!S().agentMode) {
    await fn();
    return;
  }
  try {
    await reviewAfter(fn, opts);
  } catch (e) {
    console.warn('[agent review]', e);
    S().set({ busy: false });
  }
}

/** Creates `count` designs (1-8). Above CHUNK: chunk 1 first; the rest start as soon as its designs land (not after its
 *  photos), concurrently, with an avoid-list so the set stays diverse. Returns the new design ids + what each call made.
 *  runConcepts runs quiet: no "Here's your ad" bubble — the Producer card shows progress and the concepts instead. */
async function createDesigns(
  prompt: string,
  count: number,
  opts: { referenceId?: string; reference?: Slots; referenceImage?: string; brief?: string; size?: SizeKeyLike | null; subjects?: string[]; theme?: string | null },
  onProgress?: (progress: string | null) => void,
): Promise<Built> {
  const before = ids();
  const created = () => S().designs.filter((d) => !before.has(d.id));
  const { size: key, subjects = [], theme, ...rest } = opts;
  const base = { ...rest, ...(key ? { size: { ...SIZES[key] } } : {}), ...(theme ? { theme } : {}), quiet: true, onProgress };
  const chunks = chunkCounts(count);
  // Subjects split per chunk, in order (chunk k gets the next chunks[k] subjects); absent = old behaviour.
  const subjectsFor = (k: number) => {
    const start = chunks.slice(0, k).reduce((a, b) => a + b, 0);
    const sub = subjects.slice(start, start + chunks[k]);
    return sub.length ? { subjects: sub } : {};
  };
  const built = (outs: ConceptsOutcome[]): Built => ({
    ids: created().map((d) => d.id),
    made: outs.flatMap((o) => o.designs),
    fallback: outs.flatMap((o) => o.photoFallback),
    errors: outs.flatMap((o) => (o.error ? [o.error] : [])),
    chunks,
  });
  if (chunks.length === 1) return built([await runConcepts(prompt, chunks[0], { ...base, ...subjectsFor(0) })]);
  let firstDone = false;
  const first = runConcepts(prompt, chunks[0], { ...base, ...subjectsFor(0) });
  void first.then(
    () => (firstDone = true),
    () => (firstDone = true),
  );
  const t0 = Date.now();
  while (!firstDone && !created().length && Date.now() - t0 < 200_000) await sleep(250);
  const avoid = avoidBrief(created().map((d) => d.slots ?? {}));
  const brief = [opts.brief, avoid].filter(Boolean).join('\n') || undefined;
  return built(await Promise.all([first, ...chunks.slice(1).map((n, k) => runConcepts(prompt, n, { ...base, brief, ...subjectsFor(k + 1) }))]));
}

// ---------------------------------------------------------------------------------------------
// Pipeline cards (spec §8): Brand Kit -> Strategist -> Producer on the planning message; review.ts adds Art Director.

const BRAND_KIT: AgentStep = {
  id: 'brand-kit',
  label: 'Brand Kit',
  status: 'done',
  detail: 'Loaded',
  icon: '✦',
  chips: ['Typography', 'Colours', 'Icons', 'Illustrations'],
};
/** The Brand Kit card with its thinking (read from the store when the card is posted). */
const brandKitCard = (): AgentStep => ({ ...BRAND_KIT, thinking: brandKitThinking(S().manifest, S().photos.length) });

/** Producer progress from a quiet runConcepts ("Writing 3 concepts…", "Generating photos 1/3…") on the card's detail. */
const producerProgress = (msg: string) => (p: string | null) => {
  if (p) card(msg, { id: 'produce', detail: p });
};

/** After a quiet build: the Producer card's thinking, and the error in the plan message when nothing was built. */
function showBuilt(msg: string, b: Built, text: string) {
  card(msg, { id: 'produce', thinking: producerThinking(b, S().designs, S().photos) });
  if (!b.ids.length && b.errors.length) S().updateMsg(msg, { text: `${text}\nSorry — I couldn't create that: ${b.errors[0]}` });
}

/** Adds a card to a message's pipeline, or patches the card with that id (other cards are kept). */
function card(msg: string, step: Partial<AgentStep> & { id: string }) {
  const steps = S().chat.find((m) => m.id === msg)?.steps ?? [];
  const i = steps.findIndex((s) => s.id === step.id);
  const next = i < 0 ? [...steps, { label: '', status: 'running', ...step } as AgentStep] : steps.map((s, j) => (j === i ? { ...s, ...step } : s));
  S().updateMsg(msg, { steps: next });
}

/** Right-hand detail on the Strategist card once the plan is in. */
function planDetail(plan: PlanResponse): string {
  const n = plan.count;
  switch (plan.action) {
    case 'ask':
      return `${plan.questions.length} question${plan.questions.length > 1 ? 's' : ''}`;
    case 'create':
    case 'variations':
      return `${n} design${n > 1 ? 's' : ''}`;
    case 'steps':
      return `${plan.steps.length} steps`;
    case 'resize':
      return plan.size ?? 'resize';
    default:
      return plan.action;
  }
}

/** Producer card around a piece of work: running -> done / failed. */
async function produce<T>(msg: string, label: string, work: () => Promise<T>, done: (r: T) => string | null): Promise<T> {
  card(msg, { id: 'produce', label, status: 'running', role: 'producer', icon: '✎', detail: 'working…' });
  try {
    const r = await work();
    const detail = done(r);
    card(msg, detail === null ? { id: 'produce', status: 'failed', detail: 'nothing built' } : { id: 'produce', status: 'done', detail });
    return r;
  } catch (e) {
    card(msg, { id: 'produce', status: 'failed', detail: 'error' });
    throw e;
  }
}

async function createAndReview(
  msg: string,
  lead: string,
  prompt: string,
  count: number,
  opts: Parameters<typeof createDesigns>[2],
  reviewBrief: string,
  requirements: string[] = [],
) {
  const chunks = chunkCounts(count);
  const n = chunks.reduce((a, b) => a + b, 0);
  const how =
    chunks.length > 1
      ? `Creating ${n} designs in ${chunks.length} batches (${chunks.join(' + ')}): max ${CHUNK} per call, later batches avoid the first batch's ideas.`
      : `Creating ${n} design${n > 1 ? 's' : ''}.`;
  S().updateMsg(msg, { text: `${lead}\n${how}` });
  const built = await produce(msg, `Creating ${n} design${n > 1 ? 's' : ''}`, () => createDesigns(prompt, n, opts, producerProgress(msg)), (b) =>
    b.ids.length ? `${b.ids.length} built` : null,
  );
  showBuilt(msg, built, `${lead}\n${how}`);
  const created = built.ids;
  if (!created.length || !S().agentMode) return;
  const subjects = opts.subjects ?? [];
  // Subject per design id (recorded by runConcepts), not by position: a failed batch/concept must not shift them.
  const own = created.map((id) => designSubjects.get(id) ?? '');
  const reqs = subjects.length || requirements.length ? designRequirements(created, own, requirements) : undefined;
  await reviewDesigns(created, { rounds: 2, brief: reviewBrief, ...(reqs ? { requirements: reqs } : {}) });
}

/** §5d: analyse the upload, play back what was seen, wait for "continue" or a typed correction. */
async function seeUpload(kind: PendingSee['kind'], preview: string, plan: PlanResponse) {
  const msg = say('');
  card(msg, { id: 'see', label: 'Reading your image', status: 'running', role: 'strategist', icon: '◎', detail: 'analysing…' });
  // One playback at a time: older "continue" buttons expire, and the chat waits (busy) while the image is analysed.
  for (const id of [...sees.keys()]) {
    sees.delete(id);
    S().updateMsg(id, { actions: undefined });
  }
  S().set({ busy: true });
  let a: AnalyzeResult;
  try {
    a = await withTimeout(api.analyze(preview), ANALYZE_TIMEOUT_MS, 'Image analysis');
  } catch (e) {
    card(msg, { id: 'see', status: 'failed', detail: 'failed' });
    S().updateMsg(msg, { progress: null, error: true, text: `I couldn't analyse the image: ${errorMessage(e)}. Describe the ad you want and I'll build it.` });
    return;
  } finally {
    S().set({ busy: false });
  }
  card(msg, {
    id: 'see',
    status: a.method === 'none' || !a.slots ? 'skipped' : 'done',
    detail: a.method === 'none' || !a.slots ? 'no vision' : 'Read',
    thinking: [
      {
        title: 'What I see',
        lines:
          a.method === 'none' || !a.slots
            ? ['No vision model available, so the layout could not be read']
            : [describeAnalysis(a.slots, a.texts ?? []), ...((a.texts ?? []).length ? [`Text found: ${clipWords((a.texts ?? []).join(' | '), 140)}`] : [])],
      },
    ],
  });
  if (a.method === 'none' || !a.slots) {
    S().updateMsg(msg, {
      progress: null,
      text: "I can't read this image's layout (no vision model available). Describe it — layout, colours, headline, photo — and I'll build from your description.",
    });
    return;
  }
  const texts = a.texts ?? [];
  const slots = completeSlots(a.slots, texts);
  sees.set(msg, { kind, slots, texts, plan, preview });
  S().updateMsg(msg, {
    progress: null,
    text: `${describeAnalysis(a.slots, texts)}\nIs that right? Continue — or type what's different and I'll use your correction.`,
    actions: [{ label: 'Looks right — continue', kind: 'agent-continue', payload: msg }],
  });
}

async function runSee(id: string, correction: string | null) {
  const p = sees.get(id);
  if (!p) return;
  sees.delete(id);
  S().updateMsg(id, { actions: undefined });
  const brief = [p.plan.brief, correction ? `Correction from the user about the uploaded image: ${correction}` : null].filter(Boolean).join('\n') || undefined;
  const found = p.texts.length ? ` Text found: ${p.texts.join(' | ')}` : '';
  const reviewBrief = [p.plan.prompt, brief].filter(Boolean).join(' — ');
  const lead = correction ? 'Got it — using your correction.' : 'Great — building from your image.';
  const msg = say(lead);
  if (p.kind === 'recreate') {
    const text = `${lead}\nRebuilding it as an editable on-brand design.`;
    S().updateMsg(msg, { text });
    const size = p.plan.size ? { size: { ...SIZES[p.plan.size] } } : {};
    // Quiet: the Producer card carries the progress and what was built (no separate "Here's your ad" bubble).
    const rebuild = async () => {
      const o = await produce(
        msg,
        'Rebuilding your image',
        () =>
          runConcepts(`Recreate this uploaded ad as an editable on-brand Xero design.${found}`, 1, {
            reference: p.slots,
            brief,
            ...size,
            quiet: true,
            onProgress: producerProgress(msg),
          }),
        (r) => (r.designs.length ? 'Built' : null),
      );
      showBuilt(msg, { ids: o.designs.map((d) => d.id), made: o.designs, fallback: o.photoFallback, errors: o.error ? [o.error] : [] }, text);
    };
    await reviewAfter(rebuild, { brief: reviewBrief });
    return;
  }
  const n = clampCount(p.plan.count);
  await createAndReview(msg, lead, `Create ${n} on-brand Xero ads like this uploaded design.${found}`, n, { reference: p.slots, referenceImage: p.preview, brief, size: p.plan.size }, reviewBrief);
}

async function runSteps(plan: PlanResponse, msg: string, lead: string, message: string) {
  const d0 = getActive();
  if (!d0) return;
  // Keep the Brand Kit / Strategist cards above the step cards.
  const head = (S().chat.find((m) => m.id === msg)?.steps ?? []).filter((s) => !/^step\d+$/.test(s.id));
  let steps: AgentStep[] = plan.steps.map((s, i) => ({ id: `step${i + 1}`, label: s.label, status: 'pending', role: 'producer', icon: '✎' }));
  const show = () => S().updateMsg(msg, { steps: [...head, ...steps] });
  const set = (i: number, p: Partial<AgentStep>) => {
    steps = steps.map((s, j) => (j === i ? { ...s, ...p } : s));
    show();
  };
  S().updateMsg(msg, { text: `${lead}\n${steps.length} steps — working through them in order, then one review at the end.`, steps: [...head, ...steps] });
  for (let i = 0; i < plan.steps.length; i++) {
    // Every step edits the design the run started on, even if the user switched designs meanwhile.
    if (!S().designs.some((d) => d.id === d0.id)) {
      steps = steps.map((s, j) => (j >= i ? { ...s, status: 'skipped', detail: 'design deleted' } : s));
      show();
      break;
    }
    if (S().activeId !== d0.id) S().setActive(d0.id);
    set(i, { status: 'running' });
    try {
      const r = await runStep(plan.steps[i]);
      set(i, { status: r.ok ? 'done' : 'failed', detail: r.detail });
    } catch (e) {
      console.warn('[agent step]', e);
      set(i, { status: 'failed', detail: 'error' });
    }
  }
  const failed = steps.filter((s) => s.status === 'failed').length;
  S().updateMsg(msg, { text: `${lead}\n${steps.length - failed}/${steps.length} steps done${failed ? ` (${failed} failed — see above)` : ''}. Reviewing the result…` });
  const now = S().designs.find((d) => d.id === d0.id);
  if (now && now !== d0) await reviewDesigns([d0.id], { rounds: 1, brief: message, prev: { [d0.id]: d0 } });
}

async function runStep(step: PlanStep): Promise<{ ok: boolean; detail?: string }> {
  const before = getActive();
  if (!before) return { ok: false, detail: 'no design' };
  if (step.action === 'resize') {
    const key = sizeKeyIn(step.prompt) ?? sizeKeyIn(step.label);
    if (!key) return { ok: false, detail: 'which size?' };
    const out = resizeActive(key);
    return { ok: !/^Create a design first/.test(out), detail: key };
  }
  if (step.action === 'fix') {
    const out = fixAll();
    const n = out.match(/Fixed (\d+)/)?.[1];
    return { ok: !/failed/i.test(out), detail: n ? `${n} fixed` : 'nothing to fix' };
  }
  const from = S().chat.length;
  await runEdit(step.prompt);
  const failed = S().chat.slice(from).some((m) => m.error);
  return { ok: !failed, detail: failed ? undefined : getActive() === before ? 'no change' : undefined };
}

async function act(plan: PlanResponse, message: string, msg: string) {
  const lead = `Understood: ${plan.understanding}`;
  const s = S();
  const d = getActive();
  const preview = importPreviewOf(d);
  const reviewBrief = [plan.prompt, plan.brief].filter(Boolean).join(' — ');
  const brief = plan.brief ?? undefined;
  // §9 brief fidelity: one subject per design + a theme carried by every design (absent = old behaviour).
  const fidelity = { ...(plan.subjects?.length ? { subjects: plan.subjects } : {}), ...(plan.theme ? { theme: plan.theme } : {}) };
  switch (plan.action) {
    case 'chat':
      S().updateMsg(msg, { text: plan.reply || plan.understanding });
      return;
    case 'ask': {
      const n = plan.questions.length;
      for (const id of [...asks.keys()]) {
        asks.delete(id); // one open question round at a time
        S().updateMsg(id, { answered: true });
      }
      asks.set(msg, { message, questions: plan.questions });
      S().updateMsg(msg, {
        text: `${lead}\nAsking ${n} quick question${n > 1 ? 's' : ''} so the design fits — or press "Just go" and I'll use my best guess.`,
        questions: plan.questions,
        answered: false,
      });
      return;
    }
    case 'create':
      return createAndReview(msg, lead, plan.prompt, plan.count, { referenceId: s.selectedRefId ?? undefined, brief, size: plan.size, ...fidelity }, reviewBrief, plan.requirements);
    case 'variations':
      if (preview) {
        S().updateMsg(msg, { text: `${lead}\nFirst, let me check I read your image right.` });
        return seeUpload('variations', preview, plan);
      }
      if (s.selectedRefId) return createAndReview(msg, lead, plan.prompt, plan.count, { referenceId: s.selectedRefId, brief, size: plan.size, ...fidelity }, reviewBrief, plan.requirements);
      return createAndReview(msg, lead, plan.prompt, plan.count, { reference: d?.slots, brief, size: plan.size, ...fidelity }, reviewBrief, plan.requirements);
    case 'recreate': {
      if (preview) {
        S().updateMsg(msg, { text: `${lead}\nFirst, let me check I read your image right.` });
        return seeUpload('recreate', preview, plan);
      }
      const ref = s.selectedRefId ? s.references.find((r) => r.id === s.selectedRefId) : null;
      if (ref) {
        S().updateMsg(msg, { text: lead });
        await reviewAfter(() => recreateReference(ref), { brief: reviewBrief });
        return;
      }
      return createAndReview(msg, lead, plan.prompt, 1, { brief, size: plan.size }, reviewBrief);
    }
    case 'edit': {
      S().updateMsg(msg, { text: lead });
      const flat = preview ? flatImageOf(d) : null;
      if (d && flat) return runPixelEdit(d, flat, message); // a flat upload is edited as pixels, as in classic routing
      await reviewAfter(() => produce(msg, 'Editing the design', () => runEdit(plan.prompt), () => 'Applied'), { brief: reviewBrief });
      return;
    }
    case 'resize':
      await reviewAfter(
        () => produce(msg, `Resizing to ${plan.size ?? '9:16'}`, async () => S().updateMsg(msg, { text: `${lead}\n${resizeActive(plan.size ?? '9:16')}` }), () => 'Reflowed'),
        { brief: reviewBrief },
      );
      return;
    case 'fix':
      S().updateMsg(msg, { text: `${lead}\n${fixAll()}` });
      card(msg, { id: 'produce', label: 'Brand fixes', status: 'done', role: 'producer', icon: '✎', detail: 'Applied' });
      return;
    case 'steps':
      return runSteps(plan, msg, lead, message);
  }
}

async function planAndAct(message: string, answers: Record<string, string> | null, askedAlready: boolean, questions: AgentQuestion[] = []) {
  const msg = say('');
  card(msg, brandKitCard());
  card(msg, {
    id: 'understand',
    label: askedAlready ? 'Planning with your answers' : 'Understanding your brief',
    status: 'running',
    role: 'strategist',
    icon: '◎',
    detail: 'analysing…',
  });
  S().set({ busy: true });
  let plan: PlanResponse;
  try {
    const s = S();
    const d = getActive();
    const ref = s.selectedRefId ? s.references.find((r) => r.id === s.selectedRefId) : null;
    const context: PlanContext = {
      hasDesign: !!d,
      design: d ? summarizeDesign(d) : undefined,
      slots: d?.slots,
      selectedRefId: s.selectedRefId,
      selectedRefHeadline: ref?.slots?.headline ?? null,
      hasUpload: !!importPreviewOf(d),
      uploadAnalysis: null,
      answers,
      askedAlready,
    };
    const raw = await withTimeout(agentApi.plan({ message, history: historyFor(message), context }), PLAN_TIMEOUT_MS, 'Planner');
    plan = normalizePlan(raw, { message, hasDesign: !!d, askedAlready });
  } catch (e) {
    console.warn('[agent planner]', errorMessage(e));
    card(msg, {
      id: 'understand',
      status: 'skipped',
      detail: 'slow → standard copilot',
      thinking: [
        {
          title: 'Planner',
          lines: [`No plan in time (${clipWords(errorMessage(e), 60)})`, 'Handed over to the standard copilot; the result is still reviewed', ...askedLines(answers, questions)],
        },
      ],
    });
    S().updateMsg(msg, { progress: null, text: "The planner is slow right now, so I'm going ahead with the standard copilot and will still review the result." });
    S().set({ busy: false });
    const text = withAnswers(message, answers, questions);
    await withAgentReview(() => sendMessageClassic(text), { newRounds: 2, editRounds: 1, brief: text });
    return;
  }
  card(msg, { id: 'understand', status: 'done', detail: planDetail(plan), thinking: strategistThinking(plan, { message, answers, questions }) });
  S().updateMsg(msg, { progress: null, text: `Understood: ${plan.understanding}` });
  S().set({ busy: false });
  await act(plan, message, msg);
}

// ---------------------------------------------------------------------------------------------
// Entry points (chat box, chips in chat, question UI)

/** Agent-mode chat message. The user message is already in chat (copilot.sendMessage pushed it). */
export async function agentSend(text: string) {
  const t = text.trim();
  if (!t) return;
  try {
    const open = openPending();
    if (open?.type === 'see') return await runSee(open.id, t);
    if (open?.type === 'ask') {
      const p = asks.get(open.id)!;
      asks.delete(open.id);
      S().updateMsg(open.id, { answered: true });
      const key = p.questions.length === 1 ? p.questions[0].q : 'Reply';
      return await planAndAct(p.message, { [key]: t }, true, p.questions);
    }
    // §Settled: a flat upload + anything that isn't recreate / like-this / new designs = pixel edit, no planner.
    const d = getActive();
    const flat = importPreviewOf(d) ? flatImageOf(d) : null;
    if (d && flat && !RECREATE.test(t) && !LIKE.test(t) && !wantsNewDesigns(t)) return await runPixelEdit(d, flat, t);
    await planAndAct(t, null, false);
  } catch (e) {
    console.error('[agent]', e);
    S().set({ busy: false });
    say(`Agent error: ${errorMessage(e)}`, { error: true });
  }
}

/** Next-step chip ('agent-prompt' action): send its text as if typed. */
export async function agentPrompt(payload: string) {
  const { designId, text } = parseDesignPrompt(payload);
  const t = text.trim();
  if (!t) return;
  // A chip from a multi-design review acts on the design it was written for.
  if (designId && designId !== S().activeId && S().designs.some((d) => d.id === designId)) S().setActive(designId);
  if (!S().agentMode) return sendMessage(t); // Agent switched off since the chip appeared: classic routing
  S().pushMsg({ role: 'user', text: t });
  await agentSend(t);
}

/** Question UI submit. answers: question text -> answer; null = "Just go — best guess". */
export async function answerQuestions(msgId: string, answers: Record<string, string> | null) {
  const p = asks.get(msgId);
  if (!p) return S().updateMsg(msgId, { answered: true });
  asks.delete(msgId);
  S().updateMsg(msgId, { answered: true });
  const clean: Record<string, string> = {};
  for (const [q, a] of Object.entries(answers ?? {})) if (str(a)) clean[q] = str(a);
  const echo = Object.keys(clean).length ? formatAnswers(clean, p.questions) : 'Just go — use your best guess';
  S().pushMsg({ role: 'user', text: echo });
  try {
    // Agent switched off since the questions were asked: the classic router, answers folded in.
    if (!S().agentMode) return await sendMessageClassic(withAnswers(p.message, clean, p.questions));
    await planAndAct(p.message, clean, true, p.questions);
  } catch (e) {
    S().set({ busy: false });
    say(`Agent error: ${errorMessage(e)}`, { error: true });
  }
}

/** "Looks right — continue" on a "what I see" playback ('agent-continue' action). */
export async function agentContinue(pendingId: string) {
  if (!sees.has(pendingId)) return S().updateMsg(pendingId, { actions: undefined });
  if (!S().agentMode) {
    sees.delete(pendingId);
    S().updateMsg(pendingId, { actions: undefined });
    say('Agent mode is off, so this check has expired. Use "Variations like this" or ask again.');
    return;
  }
  S().pushMsg({ role: 'user', text: 'Looks right — continue' });
  try {
    await runSee(pendingId, null);
  } catch (e) {
    S().set({ busy: false });
    say(`Agent error: ${errorMessage(e)}`, { error: true });
  }
}
