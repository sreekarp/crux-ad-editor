// Copilot flows: chat -> backend (concepts / edit / photo / upload / analyze / pixel-edit) -> design engine -> store.
// Every flow reports progress in its chat message and turns errors into chat text (never throws).
import { api, errorMessage } from '../api';
import { ACCEPTED_FILES, importFile } from '../import';
import { autoFix, buildDesign, checkDesign, summarizeDesign, type Size } from '../design';
import { SIZES } from '../brand';
import { cropChanged, focusProps, focusPropsFromResult, photoFitProps, photoShape, reframeTargets, withPhotoFocus } from '../lib/photoFocus';
import type { AsyncOp, Design, Hero, ImageLayer, Layer, PhotoLayer, Reference, Slots } from '../types';
import { getActive, uid, useEditor } from './store';
import { agentPrompt, agentSend, withAgentReview } from '../agent/agent';

const S = () => useEditor.getState();

// ---------------------------------------------------------------------------------------------
// Helpers

/** Size for new designs: the active design's size snapped to the nearest standard (4:5 / 1:1 / 9:16). */
export function activeSize(): Size {
  const d = getActive();
  if (!d) return { ...SIZES['4:5'] };
  const ratio = d.height / Math.max(1, d.width);
  const best = Object.values(SIZES).reduce((a, b) => (Math.abs(b.height / b.width - ratio) < Math.abs(a.height / a.width - ratio) ? b : a));
  return { width: best.width, height: best.height };
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const COUNT = '([1-6]|one|two|three|four|five|six)';

/** Explicit counts 1-6 are honoured when they refer to designs ("give me 6", "make 2 ads", "create 4 like this");
 *  numbers inside copy ("50% off for 3 months") are not. Plural asks ("variations", "ads") default to 3; else 1. */
export function countFor(text: string): number {
  const t = text.toLowerCase();
  const m =
    t.match(new RegExp(`\\b(?:create|make|give me|show me|generate|design|draft|want|need|try)\\s+(?:me\\s+)?${COUNT}\\b`)) ??
    t.match(new RegExp(`\\b${COUNT}\\s+(?:more\\s+)?(?:\\w+\\s+)?(?:ads?|designs?|posts?|banners?|concepts?|options|variations?|versions?|images?|ideas?|alternatives)\\b`));
  if (m) return NUM_WORDS[m[1]] ?? Number(m[1]);
  if (/\b(variations|options|alternatives|versions|concepts|ideas|ads|designs|images|posts|banners)\b/.test(t)) return 3;
  return 1;
}

const DESIGN_NOUN = '(ads?|designs?|posts?|banners?|creatives?|campaigns?|versions?|options|concepts?)';

const DESIGN_WORDS =
  /\b(ads?|designs?|posts?|banners?|images?|campaigns?|concepts?|creatives?|stor(?:y|ies)|variations?|options|flyers?|visuals?|templates?)\b/i;

/** Greetings, thanks and "what can you do" on an empty canvas get a capabilities reply, not a design. */
export function isSmallTalk(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.?\s]+$/, '');
  if (DESIGN_WORDS.test(t)) return false;
  return (
    /^(hi|hey|hello|hiya|yo|sup|howdy|good (morning|afternoon|evening)|thanks|thank you|thx|cheers|ok|okay|cool|nice|great)( there| team| copilot)?$/.test(t) ||
    /\b(what can you do|what do you do|how does this work|how do i (use|start)|help|who are you|what are you)\b/.test(t)
  );
}

/** A question with no design words (e.g. "which colours are on-brand?") is answered, not turned into an ad. */
export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return !DESIGN_WORDS.test(t) && (/\?$/.test(t) || /^(what|which|why|how|who|when|where|can|could|do|does|is|are|should)\b/.test(t));
}

const HELP_TEXT = [
  "Hi! I'm your Xero design copilot. Here's what I can do:",
  '• Make ads: "Instagram ad for cafe owners about getting paid faster" (ask for 2–6 options if you like)',
  '• Variations: pick a reference ad, then "Create 4 different images like this"',
  '• Edit in chat: "make it dark", "shorter headline", "new photo of a baker", "make it 9:16"',
  '• Import: drop a PNG, SVG or PSD; SVG/PSD text becomes editable layers',
  '• Brand guard: every design is checked against the Xero brand rules',
].join('\n');

/** Does the message ask for new design(s) (vs. an edit of the current one)? */
export function wantsNewDesigns(text: string): boolean {
  const t = text.toLowerCase();
  if (/\blike this\b|\bvariations?\b|\balternatives\b|\bconcepts?\b|\bmore options\b/.test(t)) return true;
  if (new RegExp(`\\b(new|another|fresh|different)\\s+(\\w+\\s+)?${DESIGN_NOUN}\\b`).test(t)) return true;
  if (new RegExp(`\\b([1-6]|one|two|three|four|five|six)\\s+(more\\s+)?(\\w+\\s+)?${DESIGN_NOUN}\\b`).test(t)) return true;
  // "make an ad for…", "create a post about…" (indefinite article = something new; "make the ad dark" is an edit)
  return /\b(create|make|design|generate|build|draft|give me|show me|need)\b\s+(me\s+)?(an?|some)\s+(\w+\s+){0,3}?(ads?|designs?|posts?|banners?|creatives?|campaigns?)\b/.test(t);
}

/** "make it 9:16", "resize to square"… -> size key (not when the message is about a single layer). */
export function sizeCommand(text: string): keyof typeof SIZES | null {
  const t = text.toLowerCase();
  if (!/\b(make|resize|convert|switch|change|turn|format)\b/.test(t)) return null;
  if (/\b(photo|image|picture|logo|charm|bloom|button|cta|headline|text|card)\b/.test(t)) return null;
  if (/9:16|\bstor(y|ies)\b|\breels?\b|\bvertical\b/.test(t)) return '9:16';
  if (/1:1|\bsquare\b/.test(t)) return '1:1';
  if (/4:5|\bportrait\b|\bfeed\b/.test(t)) return '4:5';
  return null;
}

/** A bloom-masked photo prefers portrait even in a near-square box: the vertical overflow lets the crop slide the
 *  head down into the visible part of the bloom. */
function orientationFor(layer: { width: number; height: number; mask?: unknown } | undefined): 'landscape' | 'square' | 'portrait' {
  if (!layer) return 'portrait';
  const r = layer.width / Math.max(1, layer.height);
  return r > 1.2 ? 'landscape' : r < 0.83 || layer.mask ? 'portrait' : 'square';
}

function defaultPhotoPrompt(hero: Hero): string {
  if (hero.photoPrompt) return hero.photoPrompt;
  const subject = hero.photoTag ? `a ${hero.photoTag} small-business owner at work` : 'a small-business owner at work';
  return `Candid natural photo of ${subject}, warm daylight, smiling, shallow depth of field, authentic, editorial`;
}

/** Bank photo for a tag, avoiding URLs already used in this batch. any=true falls back to any unused photo. */
export function pickBankPhoto(tag: string | undefined, used: Set<string>, any = false): string | null {
  const photos = S().photos;
  let cands = photos.filter((p) => p.tag === tag && !used.has(p.url));
  if (!cands.length && any) cands = photos.filter((p) => !used.has(p.url));
  if (!cands.length) return null;
  const p = cands[Math.floor(Math.random() * cands.length)];
  used.add(p.url);
  return p.url;
}

function safeAutoFix(d: Design): Design {
  try {
    return autoFix(d, S().manifest).design;
  } catch (e) {
    console.warn('[autoFix]', e);
    return d;
  }
}

function photoLayers(d: Design): PhotoLayer[] {
  return d.layers.filter((l): l is PhotoLayer => l.kind === 'photo');
}

/** Shape-aware placement right after a photo lands: keep the whole subject box inside the visible shape (re-crop, or
 *  a better-fitting chunky bloom). Silent write, so it joins the photo's own undo step. No-op without a subject box. */
function fitPhoto(designId: string, layerId: string) {
  const d = S().designs.find((x) => x.id === designId);
  const layer = d?.layers.find((l) => l.id === layerId);
  const fit = d ? photoFitProps(d, layerId) : null;
  if (fit && layer?.kind === 'photo' && cropChanged(layer, fit.props)) {
    S().apply([{ op: 'update', id: layerId, props: fit.props as Partial<Layer> }], { designId, history: false });
  }
}

/** Builds a design from slots; photo hero resolved from the bank (or flagged for generation). */
function buildFromSlots(slots: Slots, size: Size, used: Set<string>, name?: string, generate = false): { design: Design; needsPhoto: boolean } {
  const hero: Hero = { ...(slots.hero ?? { type: 'none' }) };
  let needsPhoto = false;
  // The backend already resolves bank photos per concept; a non-null photoUrl is final.
  if (hero.photoUrl) used.add(hero.photoUrl);
  if (hero.type === 'photo' && !hero.photoUrl) {
    // generate: Agent Mode subjects/theme (spec §9) — the backend dropped the bank photo on purpose, so generate.
    const url = generate && hero.photoPrompt ? null : pickBankPhoto(hero.photoTag, used);
    if (url) hero.photoUrl = url;
    else {
      hero.photoUrl = null;
      needsPhoto = true;
    }
  }
  const full: Slots = { ...slots, hero };
  let design = withPhotoFocus(buildDesign(full, size, S().manifest, { name: name ?? full.headline?.slice(0, 40) }), S().photos);
  // Bank photos with a subject box: shape-aware fit (crop, or a better-fitting chunky bloom). No-op without a box.
  for (const p of photoLayers(design)) {
    const fit = photoFitProps(design, p.id);
    if (fit && cropChanged(p, fit.props)) design = { ...design, layers: design.layers.map((l) => (l.id === p.id ? ({ ...l, ...fit.props } as Layer) : l)) };
  }
  if (needsPhoto) {
    design = {
      ...design,
      layers: design.layers.map((l) => (l.kind === 'photo' && !l.src ? ({ ...l, status: 'loading' } as Layer) : l)),
    };
    if (!photoLayers(design).length) needsPhoto = false;
  }
  return { design: safeAutoFix(design), needsPhoto };
}

/** Sets the src of a design's empty (or given) photo layer and records the URL in its slots. */
/** opts.result: the /api/photo result for a generated photo — its focus point frames the crop (bank photos use the bank's). */
function setPhoto(
  designId: string,
  url: string | null,
  opts: { layerId?: string; history?: boolean; prompt?: string; result?: { focus?: [number, number]; w?: number; h?: number } } = {},
) {
  const d = S().designs.find((x) => x.id === designId);
  if (!d) return;
  const targets = photoLayers(d).filter((l) => (opts.layerId ? l.id === opts.layerId : !l.src || l.status === 'loading'));
  if (!targets.length) return;
  S().apply(
    targets.map((l) => ({
      op: 'update' as const,
      id: l.id,
      props: url
        ? {
            src: url,
            status: 'ready' as const,
            ...(opts.prompt ? { prompt: opts.prompt } : {}),
            ...(opts.result ? focusPropsFromResult(l, d, opts.result) : focusProps(l, d, url, S().photos)),
          }
        : { status: 'error' as const },
    })),
    { designId, history: opts.history ?? false },
  );
  if (url) targets.forEach((l) => fitPhoto(designId, l.id));
  if (url && d.slots && d.slots.hero?.type === 'photo') {
    const cur = S().designs.find((x) => x.id === designId);
    if (cur?.slots) S().replace(designId, { ...cur, slots: { ...cur.slots, hero: { ...cur.slots.hero, photoUrl: url } } }, false);
  }
}

/** A chat rebuild (e.g. "use a photo of a baker" on a design without one) can leave an empty photo layer: fill it
 *  from the bank when a photo matches the subject, otherwise generate one. */
async function ensurePhotos(designId: string) {
  const d = S().designs.find((x) => x.id === designId);
  const empty = d ? photoLayers(d).filter((l) => !l.src) : [];
  if (!d || !empty.length) return;
  const hero: Hero = d.slots?.hero ?? { type: 'photo' };
  const banked = hero.photoUrl || pickBankPhoto(hero.photoTag, new Set());
  if (banked) return setPhoto(designId, banked);
  try {
    const res = await api.photo({ prompt: defaultPhotoPrompt(hero), tag: hero.photoTag, orientation: orientationFor(empty[0]), quality: 'low', ...photoShape(empty[0], d) });
    setPhoto(designId, res.url, { result: res });
  } catch {
    setPhoto(designId, pickBankPhoto(hero.photoTag, new Set(), true));
  }
}

/** Answer a question with no design open (the edit endpoint replies to questions with "ops": []). */
async function answerQuestion(t: string) {
  const msg = say('', { progress: 'Thinking…' });
  try {
    const res = await api.edit({ message: t, design: { width: 1080, height: 1350, background: 'sky', layers: [] }, history: history6() });
    S().updateMsg(msg, { text: res.reply || HELP_TEXT, progress: null });
  } catch {
    S().updateMsg(msg, { text: HELP_TEXT, progress: null });
  }
}

function history6() {
  return S()
    .chat.filter((m) => m.id !== 'welcome' && !m.progress && m.text)
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.text }));
}

function say(text: string, extra: Partial<Parameters<ReturnType<typeof useEditor.getState>['pushMsg']>[0]> = {}) {
  return S().pushMsg({ role: 'assistant', text, ...extra });
}

// ---------------------------------------------------------------------------------------------
// Flows

/** Agent Mode (spec §9): design id -> the subject its concept was written for (opts.subjects[i]); never by order. */
export const designSubjects = new Map<string, string>();

/** New design(s): POST /api/design/concepts -> photos -> buildDesign -> autoFix -> add as one batch. */
export async function runConcepts(
  prompt: string,
  count: number,
  opts: { referenceId?: string; reference?: Slots; brief?: string; size?: Size; subjects?: string[]; theme?: string } = {},
) {
  const n = Math.max(1, Math.min(6, count));
  const msg = say('', { progress: `Writing ${n} concept${n > 1 ? 's' : ''}…` });
  S().set({ busy: true });
  try {
    const asked = sizeCommand(prompt); // "Story ad: …" -> new designs in 9:16
    const size = opts.size ? { ...opts.size } : asked ? { ...SIZES[asked] } : activeSize(); // opts.size: agent planner
    const res = await api.concepts({ prompt, count: n, size, ...opts });
    const concepts = (res.concepts ?? []).slice(0, n);
    if (!concepts.length) throw new Error('The copilot returned no concepts.');
    S().updateMsg(msg, { progress: 'Laying out designs…' });
    const used = new Set<string>();
    const generate = !!(opts.subjects?.length || opts.theme);
    // One bad concept (engine error) must not sink the whole batch.
    const built = concepts.flatMap((slots, i) => {
      try {
        const b = buildFromSlots(slots, size, used, concepts.length > 1 ? `${slots.headline?.slice(0, 32) ?? 'Concept'} (${i + 1})` : undefined, generate);
        const subj = opts.subjects?.[i];
        if (subj) designSubjects.set(b.design.id, subj);
        return [b];
      } catch (e) {
        console.warn('[buildDesign]', e, slots);
        return [];
      }
    });
    if (!built.length) throw new Error('Could not lay out the returned concepts.');
    S().addDesigns(built.map((b) => b.design), prompt);
    S().set({ busy: false });
    const reply = res.reply || `Here ${concepts.length > 1 ? `are ${concepts.length} concepts` : 'is a concept'}.`;
    const toGen = built.filter((b) => b.needsPhoto);
    if (!toGen.length) {
      S().updateMsg(msg, { text: reply, progress: null });
      return;
    }
    let done = 0;
    S().updateMsg(msg, { text: reply, progress: `Generating photos 0/${toGen.length}…` });
    await Promise.all(
      toGen.map(async ({ design }) => {
        const layer = photoLayers(design)[0];
        const hero = design.slots?.hero ?? { type: 'photo' as const };
        try {
          const r = await api.photo({
            prompt: defaultPhotoPrompt(hero),
            tag: hero.photoTag,
            orientation: orientationFor(layer),
            quality: 'medium',
            ...photoShape(layer, design),
          });
          setPhoto(design.id, r.url, { prompt: defaultPhotoPrompt(hero), result: r });
        } catch (e) {
          const fallback = pickBankPhoto(hero.photoTag, used, true);
          setPhoto(design.id, fallback);
          console.warn('[photo]', errorMessage(e));
        }
        done++;
        S().updateMsg(msg, { progress: done < toGen.length ? `Generating photos ${done}/${toGen.length}…` : null });
      }),
    );
  } catch (e) {
    S().updateMsg(msg, { text: `Sorry — I couldn't create that: ${errorMessage(e)}`, progress: null, error: true });
  } finally {
    S().set({ busy: false });
  }
}

/** Runs photo / pixel_edit ops returned by applyOps. Returns the number of failed ops. */
export async function runPending(designId: string, pending: AsyncOp[], msgId?: string): Promise<number> {
  let failed = 0;
  for (const op of pending) {
    const d = S().designs.find((x) => x.id === designId);
    const layer = d?.layers.find((l) => l.id === op.id);
    if (!d || !layer) continue;
    if (op.op === 'photo') {
      if (msgId) S().updateMsg(msgId, { progress: 'Generating photo…' });
      S().apply([{ op: 'update', id: op.id, props: { status: 'loading' } as Partial<Layer> }], { designId, history: false });
      try {
        const r = await api.photo({ prompt: op.prompt, orientation: orientationFor(layer), quality: 'low', ...photoShape(layer, d) });
        // Restore the old state silently, then record the swap as one undoable step.
        S().apply([{ op: 'update', id: op.id, props: { status: 'ready' } as Partial<Layer> }], { designId, history: false });
        const framing = layer.kind === 'photo' ? focusPropsFromResult(layer, d, r) : {};
        S().apply([{ op: 'update', id: op.id, props: { src: r.url, status: 'ready', prompt: op.prompt, ...framing } as Partial<Layer> }], { designId });
        fitPhoto(designId, op.id);
      } catch (e) {
        const hadPhoto = layer.kind === 'photo' && !!layer.src;
        S().apply([{ op: 'update', id: op.id, props: { status: hadPhoto ? 'ready' : 'error' } as Partial<Layer> }], { designId, history: false });
        failed++;
        say(`Photo generation failed: ${errorMessage(e)}`, { error: true });
      }
    } else if (op.op === 'pixel_edit') {
      const src = (layer as ImageLayer | PhotoLayer).src;
      if (!src) {
        failed++;
        say('That layer has no image to edit.', { error: true });
        continue;
      }
      if (msgId) S().updateMsg(msgId, { progress: 'Editing pixels…' });
      try {
        const r = await api.pixelEdit(src, op.prompt);
        S().apply([{ op: 'update', id: op.id, props: { src: r.url } as Partial<Layer> }], { designId });
      } catch (e) {
        failed++;
        say(`Pixel edit failed: ${errorMessage(e)}`, { error: true });
      }
    }
  }
  if (msgId) S().updateMsg(msgId, { progress: null });
  return failed;
}

/** Edit the active design: POST /api/design/edit -> applyOps (+autoFix) -> pending ops -> reply. */
export async function runEdit(message: string, fallback?: () => string | null) {
  const d = getActive();
  if (!d) return runConcepts(message, countFor(message));
  const msg = say('', { progress: 'Thinking…' });
  S().set({ busy: true });
  try {
    const res = await api.edit({ message, design: summarizeDesign(d), slots: d.slots, history: history6() });
    const ops = res.ops ?? [];
    const base = S().designs.find((x) => x.id === d.id) ?? d;
    const recrop = reframeTargets(base, ops);
    const { pending, errors, fixed } = ops.length ? S().apply(ops, { designId: d.id, autofix: true }) : { pending: [], errors: [], fixed: [] };
    let text = res.reply || (ops.length ? 'Done.' : "I couldn't find anything to change.");
    if (fixed.length) text += ` (Brand guard auto-fixed ${fixed.length} issue${fixed.length > 1 ? 's' : ''}.)`;
    // Crop requests also go through the shape-aware fit ladder; never claim a re-crop that didn't happen.
    if (recrop.length) {
      recrop.forEach((lid) => fitPhoto(d.id, lid));
      const now = S().designs.find((x) => x.id === d.id);
      const moved = recrop.some((lid) => {
        const a = base.layers.find((l) => l.id === lid);
        const b = now?.layers.find((l) => l.id === lid);
        return a?.kind === 'photo' && b?.kind === 'photo' && (cropChanged(a, b) || a.src !== b.src);
      });
      if (!moved) text += ` (The photo can't be re-cropped any further; try "new photo".)`;
    }
    if (errors.length) console.warn('[ops errors]', errors);
    S().updateMsg(msg, { text, progress: pending.length ? 'Working…' : null });
    S().set({ busy: false });
    if (pending.length) await runPending(d.id, pending, msg);
    await ensurePhotos(d.id);
  } catch (e) {
    const local = fallback?.();
    if (local) S().updateMsg(msg, { text: `${local} (copilot offline: ${errorMessage(e)})`, progress: null });
    else S().updateMsg(msg, { text: `Sorry — that edit failed: ${errorMessage(e)}`, progress: null, error: true });
  } finally {
    S().set({ busy: false });
  }
}

/** Local build (no LLM) from known slots: templates and reference recreation. Photo from the bank, else generated. */
export function createDesignFromSlots(slots: Slots, title: string, note?: string): Design | null {
  const size = activeSize();
  const used = new Set<string>();
  let built: { design: Design; needsPhoto: boolean };
  try {
    built = buildFromSlots(slots, size, used, title);
  } catch (e) {
    console.warn('[buildDesign]', e);
    say(`Couldn't lay out "${title}": ${errorMessage(e)}`, { error: true });
    return null;
  }
  const { design, needsPhoto } = built;
  S().addDesigns([design], title);
  const msg = note ? say(note) : null;
  if (needsPhoto) {
    const hero = slots.hero;
    if (msg) S().updateMsg(msg, { progress: 'Generating photo…' });
    api
      .photo({
        prompt: defaultPhotoPrompt(hero),
        tag: hero.photoTag,
        orientation: orientationFor(photoLayers(design)[0]),
        quality: 'medium',
        ...photoShape(photoLayers(design)[0], design),
      })
      .then((r) => setPhoto(design.id, r.url, { result: r }))
      .catch(() => setPhoto(design.id, pickBankPhoto(hero.photoTag, used, true)))
      .finally(() => msg && S().updateMsg(msg, { progress: null }));
  }
  return design;
}

/** Instant, exact recreation of one of the 20 references (no LLM: the reference library already has its slots). */
export function recreateReference(ref: Reference) {
  S().set({ selectedRefId: ref.id });
  createDesignFromSlots(ref.slots, `Recreate ${ref.id}`, `Recreated ${ref.id} as editable layers. Ask for variations (e.g. "3 like this") whenever you like.`);
}

/** Does the file match ACCEPTED_FILES (extension or MIME type)? */
export function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return ACCEPTED_FILES.split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .some((a) => (a.startsWith('.') ? name.endsWith(a) : type === a));
}

/** Imported raster that is still a single flat image (no slots): chat messages become pixel edits. */
export function flatImageOf(d: Design | null): ImageLayer | null {
  if (!d || d.slots) return null;
  const visible = d.layers.filter((l) => !l.hidden);
  const flat = visible.find((l): l is ImageLayer => l.kind === 'image' && l.role === 'flat-image');
  return flat && visible.length === 1 ? flat : null;
}

/** Flattened PNG of an imported design (for /api/analyze), if the design came from a file. */
export function importPreviewOf(d: Design | null): string | null {
  if (!d || d.slots) return null;
  return S().imports[d.id]?.previewUrl ?? flatImageOf(d)?.src ?? null;
}

/** Upload / drop: the importer (src/import) turns PNG/JPG/WEBP/SVG/PSD into an editable Design. */
export async function handleUpload(file: File) {
  if (!isAcceptedFile(file)) {
    say(`Unsupported file: ${file.name}. Use PNG, JPG, WEBP, SVG or PSD.`, { error: true });
    return;
  }
  const canPreview = /^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type);
  const userMsg = S().pushMsg({ role: 'user', text: `Uploaded ${file.name}`, image: canPreview ? URL.createObjectURL(file) : undefined });
  const msg = say('', { progress: `Importing ${file.name}…` });
  try {
    const { kind, design, previewUrl, notes } = await importFile(file);
    const d: Design = S().designs.some((x) => x.id === design.id) ? { ...design, id: uid('d_') } : design;
    S().set({ imports: { ...S().imports, [d.id]: { previewUrl, kind } }, selectedRefId: null });
    S().addDesigns([d], `Import ${file.name}`);
    if (!canPreview && previewUrl) S().updateMsg(userMsg, { image: previewUrl });
    const lead = (notes ?? []).filter(Boolean).join('\n');
    const tail = flatImageOf(d)
      ? 'I can analyse it and rebuild it as an editable on-brand design, make variations like it — or just describe a pixel edit (e.g. "make the background brighter").'
      : 'Its text and images are now editable layers. I can also rebuild it on-brand or make variations like it.';
    S().updateMsg(msg, {
      progress: null,
      text: lead ? `${lead}\n\n${tail}` : tail,
      actions: previewUrl
        ? [
            { label: 'Analyze & recreate', kind: 'recreate-upload', payload: previewUrl },
            { label: 'Variations like this', kind: 'four-like-upload', payload: previewUrl },
          ]
        : undefined,
    });
  } catch (e) {
    S().updateMsg(msg, { text: `Import failed: ${errorMessage(e)}`, progress: null, error: true });
  }
}

export function completeSlots(p: Partial<Slots>, texts: string[] = []): Slots {
  return {
    template: p.template ?? 'card',
    colourway: p.colourway ?? 'light',
    headline: p.headline ?? texts[0] ?? 'Run your business, not your books.',
    headline2: p.headline2 ?? null,
    sub: p.sub ?? null,
    cta: p.cta ?? 'Find out more',
    ctaStyle: p.ctaStyle,
    disclaimer: p.disclaimer ?? null,
    items: p.items ?? null,
    tags: p.tags,
    stat: p.stat ?? null,
    hero: p.hero ?? { type: 'photo', photoTag: 'laptop' },
    bloom: p.bloom,
    charms: p.charms ?? [],
    market: p.market,
  };
}

/** /api/analyze -> complete Slots, or null when the image could not be read. */
async function analyzeToSlots(url: string): Promise<{ slots: Slots; texts: string[] } | null> {
  const a = await api.analyze(url);
  if (a.method === 'none' || !a.slots) return null;
  const texts = a.texts ?? [];
  return { slots: completeSlots(a.slots, texts), texts };
}

/** Imported image (flattened PNG) -> /api/analyze -> one concept rebuilt as editable on-brand layers. */
export async function recreateUpload(url: string) {
  const msg = say('', { progress: 'Analysing the image…' });
  try {
    const r = await analyzeToSlots(url);
    if (!r) {
      S().updateMsg(msg, {
        progress: null,
        text: "I couldn't read this image's layout. You can still edit it with pixel edits — describe the change you want.",
      });
      return;
    }
    S().updateMsg(msg, { progress: null, text: 'Read the layout. Rebuilding it as an editable on-brand design…' });
    const prompt = `Recreate this uploaded ad as an editable on-brand Xero design.${r.texts.length ? ` Text found: ${r.texts.join(' | ')}` : ''}`;
    await runConcepts(prompt, 1, { reference: r.slots });
  } catch (e) {
    S().updateMsg(msg, { text: `Analysis failed: ${errorMessage(e)}. You can still use pixel edits via chat.`, progress: null, error: true });
  }
}

/** Imported image as the reference for N on-brand variations (default 4). */
export async function fourLikeUpload(url: string, count = 3, brief?: string) {
  const msg = say('', { progress: 'Analysing the image…' });
  try {
    const r = await analyzeToSlots(url);
    if (!r) {
      S().updateMsg(msg, {
        progress: null,
        text: "I couldn't read this image's layout, so I can't base variations on it. Try describing the ad you want instead.",
      });
      return;
    }
    S().updateMsg(msg, { progress: null, text: 'Got it — using your image as the reference.' });
    const prompt = `Create ${count} on-brand Xero ads like this uploaded design.${r.texts.length ? ` Text found: ${r.texts.join(' | ')}` : ''}`;
    await runConcepts(prompt, count, { reference: r.slots, ...(brief ? { brief } : {}) });
  } catch (e) {
    S().updateMsg(msg, { text: `Analysis failed: ${errorMessage(e)}`, progress: null, error: true });
  }
}

export async function runPixelEdit(d: Design, layer: ImageLayer, prompt: string) {
  const msg = say('', { progress: 'Editing pixels…' });
  S().set({ busy: true });
  try {
    const r = await api.pixelEdit(layer.src, prompt);
    S().apply([{ op: 'update', id: layer.id, props: { src: r.url } as Partial<Layer> }], { designId: d.id });
    S().updateMsg(msg, { progress: null, text: 'Done — pixel edit applied. Undo restores the previous image.' });
  } catch (e) {
    S().updateMsg(msg, { progress: null, text: `Pixel edit failed: ${errorMessage(e)}`, error: true });
  } finally {
    S().set({ busy: false });
  }
}

// ---------------------------------------------------------------------------------------------
// Local (deterministic) actions used by chips and the brand badge

export function fixAll(): string {
  const d = getActive();
  if (!d) return 'Nothing to fix yet — create a design first.';
  try {
    const before = checkDesign(d, S().manifest);
    const r = autoFix(d, S().manifest);
    if (!r.fixed.length) return before.length ? "The remaining issues need a manual fix (see the brand badge)." : 'This design is already on-brand.';
    S().replace(d.id, r.design, true);
    const list = r.fixed.slice(0, 6).map((i) => `• ${i.message}`).join('\n');
    return `Fixed ${r.fixed.length} brand issue${r.fixed.length > 1 ? 's' : ''}.\n${list}`;
  } catch (e) {
    return `Auto-fix failed: ${errorMessage(e)}`;
  }
}

export function resizeActive(key: keyof typeof SIZES): string {
  const d = getActive();
  if (!d) return 'Create a design first.';
  const size = SIZES[key];
  if (d.width === size.width && d.height === size.height) return `Already ${key}.`;
  const { errors } = S().apply([{ op: 'resize', width: size.width, height: size.height }], { autofix: true });
  if (key === '9:16') S().set({ showSafeZone: true });
  return errors.length ? `Resized with warnings: ${errors[0]}` : `Resized to ${key} (${size.width}×${size.height}).`;
}

/** New photo for the selected (or first) photo layer: another bank photo with the same tag, else generate. */
export async function newPhoto(prompt?: string) {
  const d = getActive();
  if (!d) return say('Create a design first.');
  const sel = S().selection[0];
  const layer = photoLayers(d).find((l) => l.id === sel) ?? photoLayers(d)[0];
  if (!layer) return say('This design has no photo layer. Add one from Brand kit → Photos.');
  const tag = d.slots?.hero?.photoTag;
  if (!prompt) {
    const used = new Set<string>(layer.src ? [layer.src] : []);
    S()
      .designs.flatMap((x) => photoLayers(x))
      .forEach((l) => l.src && used.add(l.src));
    const bank = pickBankPhoto(tag, used);
    if (bank) {
      S().apply([{ op: 'update', id: layer.id, props: { src: bank, status: 'ready', ...focusProps(layer, d, bank, S().photos) } as Partial<Layer> }], { designId: d.id });
      fitPhoto(d.id, layer.id);
      return say('Swapped in a different photo from the bank. Ask again for a freshly generated one.');
    }
  }
  const p = prompt || layer.prompt || defaultPhotoPrompt(d.slots?.hero ?? { type: 'photo', photoTag: tag });
  const msg = say('', { progress: 'Generating photo…' });
  const failed = await runPending(d.id, [{ op: 'photo', id: layer.id, prompt: p }]);
  S().updateMsg(msg, { progress: null, text: failed ? 'The photo could not be generated — the previous one is kept.' : 'New photo generated.' });
}

function localDark(): string | null {
  const d = getActive();
  if (!d?.slots) return null;
  const r = S().apply([{ op: 'rebuild', slots: { colourway: 'dark' } }], { autofix: true });
  return r.errors.length ? null : 'Switched to the dark colourway.';
}

// ---------------------------------------------------------------------------------------------
// Entry points

export const CHIPS = ['Variations like this', 'Make it dark', 'Shorter headline', 'New photo', 'Fix brand issues', 'Make 9:16'] as const;
export type Chip = (typeof CHIPS)[number];

/** Chip under the chat. Agent mode: same flow, then the review loop (new designs: 2 rounds, edits: 1). */
export async function runChip(chip: Chip) {
  // Agent mode + an upload: variations go through the agent so it plays back what it sees first (spec §5d).
  if (S().agentMode && chip === 'Variations like this' && !S().selectedRefId && importPreviewOf(getActive())) return agentPrompt(chip);
  if (S().agentMode) return withAgentReview(() => runChipClassic(chip), { newRounds: 2, editRounds: 1 });
  return runChipClassic(chip);
}

async function runChipClassic(chip: Chip) {
  const s = S();
  s.pushMsg({ role: 'user', text: chip });
  const d = getActive();
  switch (chip) {
    case 'Variations like this': {
      if (s.selectedRefId) return runConcepts('Variations like this', 3, { referenceId: s.selectedRefId });
      const preview = importPreviewOf(d);
      if (preview) return fourLikeUpload(preview);
      if (d?.slots) return runConcepts('Variations like this design', 3, { reference: d.slots });
      return runConcepts('On-brand Xero ad concepts for small businesses', 3);
    }
    case 'Make it dark':
      return runEdit('Make it dark', localDark);
    case 'Shorter headline':
      return runEdit('Make the headline shorter and punchier');
    case 'New photo':
      return newPhoto();
    case 'Fix brand issues':
      say(fixAll());
      return;
    case 'Make 9:16':
      say(resizeActive('9:16'));
      return;
  }
}

/** Free-text message from the chat box. Agent mode hands over to the planner (src/agent/agent.ts). */
export async function sendMessage(text: string) {
  const t = text.trim();
  if (!t) return;
  S().pushMsg({ role: 'user', text: t });
  if (S().agentMode) return agentSend(t);
  return sendMessageClassic(t);
}

/** Regex routing (non-agent mode, and the agent's fallback when the planner is down). The user message is already in chat. */
export async function sendMessageClassic(text: string) {
  const t = text.trim();
  if (!t) return;
  const s = S();
  const d = getActive();
  const preview = importPreviewOf(d);
  if (d && preview) {
    if (/recreate|rebuild|on-brand|editable/i.test(t)) return recreateUpload(preview);
    if (/like this|similar|variations?|alternatives/i.test(t) || (wantsNewDesigns(t) && countFor(t) > 1)) {
      return fourLikeUpload(preview, countFor(t) > 1 ? countFor(t) : 3);
    }
    const flat = flatImageOf(d);
    if (flat && !wantsNewDesigns(t)) return runPixelEdit(d, flat, t);
  }
  const size = d && !wantsNewDesigns(t) ? sizeCommand(t) : null;
  if (size) return void say(resizeActive(size));
  if (d && /^(please\s+)?fix(\s+(it|all|everything|(the\s+)?(brand(\s+issues)?|issues)))?[.!]?$/i.test(t)) return void say(fixAll());
  // Empty canvas: small talk and plain questions are answered; anything that reads like a brief still makes a design.
  if (!d && !s.selectedRefId && isSmallTalk(t)) return void say(HELP_TEXT);
  if (!d && !s.selectedRefId && isQuestion(t)) return answerQuestion(t);
  if (!d || wantsNewDesigns(t)) {
    const ref = s.selectedRefId;
    const likeThis = /like this|similar|variations?|alternatives/i.test(t);
    return runConcepts(t, countFor(t), {
      referenceId: ref ?? undefined,
      reference: !ref && likeThis && d?.slots ? d.slots : undefined,
    });
  }
  return runEdit(t, /\bdark\b/i.test(t) ? localDark : undefined);
}
