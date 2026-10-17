# Agent Mode — design (17 Oct 2026, hackathon day, deadline 18:15)

## Intent
Today the copilot is a fixed pipeline: one LLM call per chat message (`/api/design/concepts` or `/api/design/edit`),
routing by regex in `frontend/src/editor/copilot.ts` (`sendMessage`, `countFor`, `wantsNewDesigns`), no clarifying
questions, no look at the result. It is reliable but not agentic.

Agent Mode adds two loops on top of the existing pipeline, behind a switch, so the current workflow is untouched:

1. **Understand loop** — before acting, the agent decides if it understands the request. If not, it asks 1–3 short
   questions with clickable answer chips (plus free-text "Other" and a "Just go — best guess" button), then acts.
2. **Quality loop** — after creating (or editing) designs, the agent renders each one, scores it (deterministic brand
   checker + Flash vision critique), applies fixes, re-scores, and keeps the better version. The score going up is
   shown in chat ("72 → 88") so judges can see the agent measuring its own work.

## Goals
- Toggle "Agent" in the top bar. **Off by default.** Off = exactly today's behaviour.
- In agent mode, free-text chat goes through an LLM planner instead of regex routing.
- Clarifying questions only when missing info would change the output (business/audience, message/offer, how many
  options, format). Max one round of questions per request; the second planner call must act.
- Question UI: per question, single-select chips + "Other…" text box; a "Just go — use your best guess" button and a
  "Continue" button. Answers are echoed as a user message ("Audience: cafés · Offer: 3 months free · 2 options").
- **No fixed count.** "4" in the brief is only an example. In agent mode the count comes from the user ("an ad" → 1,
  "6 options" → 6); if they ask for several without a number, the planner asks "How many options?". Safety ceiling 8.
  Above 4, `/api/design/concepts` calls are split into parallel chunks of ≤4 (Pro's output budget ~4 concepts/call);
  diversity is enforced across chunks by passing the earlier chunks' templates/headlines as "avoid" context.
  Non-agent mode keeps today's 1–4 behaviour.
- Review loop on every newly created design (in parallel), max 2 rounds; on agent-mode chat edits, 1 round.
  Also on chip-triggered creation/edits while agent mode is on.
- Visible trace in chat: understood → (asked) → built N → reviewing → per-design score before → after, fixes applied.

## Non-goals
- No multi-agent system, no provider tool-calling API (planner returns JSON, like the rest of the app).
- No changes to non-agent behaviour. No new npm/pip dependencies.
- No agent memory beyond the existing chat history.

## Anti-goals (failure even if it "works")
- Agent blocks the demo: asks twice, waits forever, or loops. → hard caps (1 question round, 2 review rounds,
  time budgets) and "Just go" always available.
- Review makes a design worse. → keep-best: if the re-score is lower, revert the fix.
- Review breaks brand rules. → every fix goes through `store.apply(..., { autofix: true })`.
- Review adds more than ~45 s after photos are ready. → per-call timeouts + an overall budget; on timeout stop and report.

## Constraints / facts from the codebase
- LLM: DeepSeek via `backend/app/llm.py` `chat_json(messages, tier, timeout, max_tokens, temperature)`.
  **Flash accepts `image_url`, Pro does not** (`backend/app/analyze.py`). Vision critique = Flash only.
- Ops vocabulary already exists (`update | add | delete | reorder | rebuild | resize | photo | pixel_edit`), applied by
  `useEditor.getState().apply(ops, { designId, autofix })` which returns `{ pending, errors, fixed }`.
- Brand checker: `checkDesignImpl` / `brandScoreImpl` (0–100) in `frontend/src/design/checker.ts`; `autoFix` in `design`.
- Chat messages already support action buttons (`ChatMsg.actions`, rendered in `RightPanel.tsx` ~line 66).
- PNG export uses the live Konva stage (`stageHandle` in `CanvasArea.tsx`, `exportPng` in `TopBar.tsx`). Only the active
  design has a mounted stage → non-active designs need an offscreen render (see Rendering).
- Images are same-origin via the Vite proxy (canvas not tainted). Fonts: `ensureFonts()`; images: `whenImagesIdle()`.
- `/api/design/concepts` already accepts `brief` — clarified answers go there.

## Design

### 1. Mode switch (frontend)
- `store.ts`: `agentMode: boolean` (default false), persisted in `localStorage` (wrapped in try/catch).
- `TopBar.tsx`: an "Agent" toggle pill with a short tooltip ("Asks when unclear, reviews its own work").
- `copilot.ts` `sendMessage`: first line — if `agentMode`, push the user message and hand over to `agent.ts`
  `agentSend(text)`; else unchanged.
- `runConcepts` returns the created design ids; `runEdit` returns the edited design id (no behaviour change).
  When `agentMode` is on, `runConcepts` / `runEdit` call `reviewDesigns(ids, { rounds })` at the end
  (covers chips too). Review starts only after photos are loaded.

### 2. Planner — `POST /api/agent/plan` (backend, Flash, timeout ~15 s)
Request: `{ message, history (last 6), context: { hasDesign, design?: summary, slots?, selectedRefId?, hasUpload,
answers?: {question: answer}, askedAlready: bool } }`.
Response JSON (pydantic-validated, one retry with the validation error, like `/edit`):
```json
{ "understanding": "one line, what the user wants",
  "action": "ask | create | variations | edit | recreate | resize | fix | chat",
  "questions": [{ "id": "audience", "q": "Who is this ad for?", "options": ["Cafés", "Tradies", "Retail", "Any small business"] }],
  "prompt": "rewritten request for the existing endpoint",
  "brief": "merged facts from the answers",
  "count": 1, "size": "4:5 | 1:1 | 9:16 | null", "reply": "for action=chat" }
```
Prompt rules: ask only if the answer would change the design; max 3 questions, 2–4 options each; never ask when the
user referenced an image/reference + "like this"; if `askedAlready` is true, **never** return `ask`; never ask about
brand things the system decides (colours, fonts, logo). Few-shot examples: vague ("make an ad") → ask;
specific ("4 ads for cafés, 50% off for 3 months") → create count 4; "shorter headline" with a design → edit.
Server-side guard: if `askedAlready` and action == ask → coerce to create/edit.
Frontend fallback: if `/plan` fails, run today's `sendMessage` path (agent mode never makes things worse).

### 3. Question UI (frontend)
- `ChatMsg.questions?: AgentQuestion[]` + `ChatMsg.answered?: boolean`.
- `RightPanel.tsx` renders them under the assistant bubble: per question a row of chips (single-select, highlighted),
  "Other…" chip that reveals a small input; "Continue" (enabled once each question has an answer) and
  "Just go — best guess" (always enabled). After submit the controls lock.
- Submit → echo a user message, call `/plan` again with `answers` and `askedAlready: true` → act.

### 4. Act (frontend `agent.ts`)
Dispatch to existing functions: `create/variations` → `runConcepts(prompt, count, { brief, referenceId })`;
`edit` → `runEdit(prompt)`; `recreate` → `recreateUpload`; variations with upload → `fourLikeUpload(preview, count)`;
`resize` → `resizeActive`; `fix` → `fixAll`; `chat` → say reply. Pixel edits on a flat import keep today's routing.
First trace line in chat: "Understood: <understanding>".

### 5. Review loop (frontend `review.ts` + `POST /api/agent/critique`)
For each design id, in parallel (each round):
1. Wait for its photos (no layer with `status: 'loading'`, then `whenImagesIdle()`).
2. `brand = brandScore(check(design))`.
3. Render to JPEG data URL, longest side 768 px (see Rendering).
4. `POST /api/agent/critique { image, design: summary, slots, brief, brandIssues }` → Flash vision, timeout ~25 s:
   ```json
   { "visionScore": 0-100, "verdict": "pass | fix",
     "issues": ["Headline overlaps the photo", "..."],
     "ops": [ ...max 4, only update | rebuild | delete | photo... ], "summary": "one line" }
   ```
   Rubric in the prompt: legibility/contrast, hierarchy (headline dominant, exactly one CTA), crowding/overlaps,
   text clipped or overflowing, awkward photo crop (faces cut), copy fits the brief, brand rules.
   Server filters ops to the allowed kinds and validates them (`normalize_ops`).
5. `score = round(0.4 * brand + 0.6 * visionScore)`.
6. Round 1 with verdict `fix` and ops → `apply(ops, { designId, autofix: true })` as one undoable step → run pending
   photo ops → round 2 measures again. If round-2 score < round-1 score → revert (undo that step). Stop when score ≥ 85,
   verdict `pass`, or rounds exhausted.
7. If vision is unavailable/fails → text-only critique (summary + brand issues, no image) so the loop still runs.
Budget: whole review ≤ 60 s; on overrun stop and report the scores so far.
Trace: one chat message updated live, one line per design: `#2 72 → 88 · shortened headline, moved charm`.
Final line: "Reviewed 4 designs · average 71 → 86 · 6 fixes". Per-design "select" action buttons (existing
`select-design` action kind).

### 5b. Multi-step requests (planner `steps`)
The planner may return `"steps": [{ "action", "prompt", "label" }, ...]` (max 5) instead of a single action when one
message holds several changes ("make it dark, shorten the headline and add a coffee charm"). `agent.ts` runs them in
order against the active design, showing a checklist in one chat message (☐ → spinner → ✓ / ✗ per step); a failed step
is reported and the rest continue. The review round runs once at the end, not after every step.

### 5c. Proactive next-step chips
After a create/edit finishes (and its review), the agent offers 2–3 tailored follow-up chips as `ChatMsg.actions`
(new action kind `agent-prompt` whose payload is the prompt to send through `agentSend`). Source: the critique returns
`"suggestions": ["Make a 9:16 story version", "Try the dark colourway for contrast", ...]` (max 3, phrased as user
requests, must be things the system can do). If no critique ran, the planner's `reply` step may supply them.

### 5d. "What I see" before working from an upload
When the user uploads a flat image and asks for recreate / variations in agent mode, the agent first calls the existing
`/api/analyze`, then shows a playback message: "I see: card layout, light colourway, florist photo, headline
'…', 2 charms (heart, sparkle)." with actions "Looks right — continue" / "Change something" (opens the free-text box,
the correction is passed as `brief`). Analysis method `none` (no vision) → say so and ask the user to describe it.
The confirmed analysis is reused (no second `/analyze` call).

### 6. Rendering non-active designs
A small offscreen renderer: mount `<DesignStage>` for the design in a hidden container (fixed, off-screen,
`pointer-events: none`), `await ensureFonts()` + `whenImagesIdle()` + two animation frames, then
`stage.toDataURL({ mimeType: 'image/jpeg', quality: 0.85, pixelRatio: 768 / max(w, h) })`, unmount.
Use the same approach for the active design (simpler than toggling editor overlays). One render at a time is fine.

### 7. Backend files
- `backend/app/agent.py`: `APIRouter` with `/api/agent/plan` and `/api/agent/critique`; included in `main.py`.
- `backend/app/prompts.py`: `plan_messages(...)`, `critique_messages(...)` reusing `ROLE`, `BRAND`, `TEMPLATES`, `COPY`,
  `_vocab()`, `EDIT_OPS`.
- `backend/app/schemas.py`: `PlanRequest/Response`, `CritiqueRequest/Response`.
- `backend/scripts/smoke_test.py`: add one plan call (vague + specific) and one critique call on a reference render.

### 8. Polish pass — GetCrux-inspired agent visuals (approved 15:15, after the build)
Inspired by getcrux.ai feature cards (Command Centre / Creative Producer / Market Researcher / Creative Strategist):
agent work shown as glass step cards with an icon and a live status ("analysing…" → "✓ Done"), named agent roles.
- **A. Step cards.** Restyle `StepList` rows as compact cards: icon + label left, status right ("analysing…" with spinner
  while running, "✓ Done" when done, detail like "72 → 88" when present, "✗ Failed" / "Skipped"). Subtle glass look
  that still fits the existing light editor UI (navy/sky tokens, rounded-xl, thin border, soft tint per role); a thin
  dashed connector between consecutive cards. No new dependencies.
- **B. Brand Kit card.** At the start of each agent run (planner call), the first step card is
  "Brand Kit" with four mini chips: Typography · Colours · Icons · Illustrations → "✓ Done" (it is loaded context: the
  manifest + brand rules). Shows the agent grounds every decision in the brand guidelines. Shown once per run.
- **C. Named roles.** Each step carries a role tag: **Strategist** (understand / ask / plan / what-I-see),
  **Producer** (create / edit / steps / photos), **Art Director** (review / scores / suggestions). Tag shown as a
  small pill on the card; role colour tints the card (Strategist sky, Producer mint, Art Director lilac — bloom tokens).
- Contract change: `AgentStep` gains optional `role?: 'strategist' | 'producer' | 'art-director'` and
  `icon?: string`, and optional `chips?: string[]` (Brand Kit card). agent.ts / review.ts set them.

### 9. Brief fidelity + themed photos (approved 16:05 after the "Christmas campaign" test)
Observed: "Christmas ad campaign for local business owners" → answers "bakery, florist and restaurant, 3" → got bakery,
florist and a phone/app hero (#3); review passed all at 87–89 with 0 fixes; Christmas only in copy (bank photos).
Causes: concepts layout-mix hint forces a device hero for 3+ product concepts (main.py); bank photoUrl attached by
`_diversify`; critic checks copy only against the brief and cannot touch photos; score = 0.4·brand(≈100) + 0.6·vision
gives 40 free points; planner asked "how many" instead of "which businesses".
Decisions (Sreekar): variety across designs stays (no forced consistent look), but the THEME must be heard in every
design — copy and photo scene. Generate new photos when required (theme, or subject not in the bank), and frame them
correctly (subject/face kept in view in the bloom/frame).
- Planner: new fields `subjects[]` (one per design, in order), `theme`, `requirements[]` (types.ts). Campaign / several
  businesses unnamed → ask "Which businesses?" as a **multi-select** question (`multi: true`); count = number picked
  unless the user gave a count. Named subjects + theme → act directly.
- Concepts (`/api/design/concepts`, optional `subjects`, `theme`): concept i uses subjects[i] for its hero photo (no
  device/illustration swap); headline or sub of every concept carries the theme; photoPrompt = subject in a
  theme-appropriate scene (e.g. Christmas: fairy lights, wreath, festive shop window), brand photo style, no text.
  When `theme` is set, or a subject has no matching bank tag, do NOT attach a bank photoUrl → the frontend generates.
  Skip the device-hero mix hint whenever subjects or theme are given.
- Photo framing: `/api/photo` also returns `focus: [x, y]` (main face, Flash vision, same prompt as
  backend/scripts/bank_focus.py; ≤6 s, omitted on failure). Frontend `setPhoto` frames generated photos with it via
  `frameSubject` and stores subject/srcW/srcH, exactly like bank photos.
- Art Director: critique receives per-design `requirements` (plan.requirements + "Photo shows <subject i>");
  returns `briefMisses`; any miss → verdict fix, visionScore ≤ 70; may return ONE `photo` op on the hero photo layer
  (prompt = subject + themed scene) — review then generates it (framed) and re-scores; photo rounds get a 90 s budget.
- Score: `score = visionScore − 8 × brand errors − 3 × brand warnings` (clamped 0–100); brand stays a penalty, not a
  40-point bonus. Pass ≥ 85.

## Builder's discretion
Exact component styling (match existing `ui.tsx`), prompt wording, trace formatting, how the offscreen stage is mounted
(portal vs. a root-level host component), test coverage beyond: planner guard (askedAlready → never ask), op filtering,
score combination + keep-best decision (vitest / pytest-free smoke).

## Settled after builder review (Claude's calls)
- **"Round" = critique → (if verdict `fix`) apply one fix → re-measure.** Every fix is measured before it is kept
  (keep-best per round). New designs: up to 2 rounds (so up to 3 critiques). Edits: 1 round (critique, fix, re-measure).
- **Budget: 45 s after photos are ready**, per design in parallel; the 60 s in section 5 is replaced by 45 s.
  The review **never generates images**: allowed critique ops are `update | rebuild | delete | reorder` only
  (`photo` and `pixel_edit` are filtered out server-side and not offered in the prompt). Rebuild keeps the existing photo.
- **User acts during review:** each design is snapshotted before a fix. Before applying or reverting, the loop checks
  the design object is still the one it last saw (reference equality in the store); if the user changed it, that design
  is skipped ("#2 skipped — you edited it"). Reverts swap the snapshot back via a new store method
  `replaceDesign(id, design, { history })` (store `undo()` only works on the active design). The chat input stays usable.
- **Flat-import pixel edits:** `agentSend` keeps today's upload routing first — if the active design is a flat import
  and the message is not "recreate" / "like this" / new designs (existing regexes), it goes straight to `runPixelEdit`
  without the planner. Recreate / like-this on an upload go through the planner (actions `recreate` / `variations`).

## Calls made by Claude (not explicitly decided by Sreekar)
- Review scope: every created design, in parallel (Sreekar questioned the fixed 4 rather than picking a scope).
- Count ceiling 8 in agent mode (Sreekar: "don't fixate on 4"); chunked concept calls above 4.
- Dropped: "agent picks the best design" (Sreekar unsure). Open-ended tool loop = presentation "next step", not built.
- Score = 40% brand checker + 60% vision; pass threshold 85; keep-best revert.
- Chip-triggered creation/edit is also reviewed when agent mode is on.
- Planner failure falls back to today's routing.

## Time plan (now ~14:45)
14:45–15:15 backend `/plan` + `/critique` + prompts, curl-tested ·
15:15–15:45 toggle, `agent.ts`, question UI ·
15:45–16:30 offscreen render + review loop + trace ·
16:30–16:50 hook edits/chips, budgets, fallbacks ·
16:50–17:20 multi-step (5b), next-step chips (5c), "what I see" (5d) ·
17:20–17:40 end-to-end runs on refs + an unseen prompt · then demo recording (tight: 5b–5d are cut first if late).
