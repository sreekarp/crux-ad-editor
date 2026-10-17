# Agent Mode — implementation plan

Spec: `docs/superpowers/specs/2026-10-17-agent-mode-design.md` (read it first; "Settled after builder review" overrides earlier text).
Contract (already written, do not change shapes without updating both sides): `frontend/src/agent/types.ts`, `frontend/src/agent/api.ts`.

## Ground rules (another Claude session also edits this repo)
- Not a git repo. New code goes in NEW files. Shared files: small targeted `Edit`s only, re-read right before editing,
  never `Write` a whole existing file.
- Non-agent mode must behave exactly as before. Keep `cd frontend; npx tsc -p .; npx vitest run` green (102+ tests) and
  `docs/DEMO.md` flows working.
- Backend on :8000 runs WITHOUT --reload. After backend edits restart it:
  stop: PowerShell `Get-NetTCPConnection -LocalPort 8000 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`
  (also kill python processes whose command line contains 'spawn_main');
  start (background): `cd backend; .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000`.
  `python` is not on PATH — use `backend/.venv/Scripts/python.exe`. Vite on :5173 hot-reloads; proxies /api to :8000.
- Backend concept count cap is 6 per call (main.py). Agent mode chunks creation into calls of ≤4, ceiling 8 total.

## Task A — Backend (owner: backend agent)
Files: NEW `backend/app/agent.py` (APIRouter, prefix-less, routes `/api/agent/plan` + `/api/agent/critique`);
APPEND to `backend/app/prompts.py` (`plan_messages`, `critique_messages`, reuse ROLE/BRAND/TEMPLATES/COPY/_vocab()/EDIT_OPS);
APPEND to `backend/app/schemas.py` (PlanRequest/PlanContext/CritiqueRequest pydantic models, lenient: extra fields ignored);
ONE line in `backend/app/main.py` to include the router.
- `/plan`: Flash, timeout 15s, max_tokens ~1200, temp 0.3, `chat_json`. Validate + one retry with the error. Response
  exactly `PlanResponse` in types.ts. Guards: clamp count 1–8; questions ≤3 with 2–4 options, ids slugified; if
  `askedAlready` and action=='ask' → 'create' (no design) or 'edit' (design); 'ask' with no valid questions → same;
  'steps' with <2 valid steps → 'edit' with the joined prompt; prompt defaults to the message; never ask about brand
  colours/fonts/logo; with an upload/reference + "like this" → don't ask. LLM down → HTTP 503.
  Few-shots: "make an ad" → ask (business/audience, offer/message, how many); "6 ads for cafés, 3 months free" →
  create count 6; "shorter headline" (design) → edit; "make it dark, shorten the headline and add a coffee charm" →
  steps; "make it a story" → resize 9:16; "hi / what can you do" → chat.
- `/critique`: Flash with image_url when `image` given (fall back to text-only on any error, `usedVision=false`),
  timeout 25s, max_tokens ~1500, temp 0.2. Rubric per spec §5. Response exactly `CritiqueResponse`. visionScore clamp
  0–100; issues ≤5; suggestions ≤3 (only things the app can do: colourway switch, resize 1:1/9:16, shorter headline,
  new copy angle, swap charm, different template, variations); ops filtered to update|rebuild|delete|reorder, ≤4,
  validated with `normalize_ops(raw, design, slots)`; verdict 'pass' if no ops survive.
- Verify: restart backend, curl both endpoints (vague + specific plan; critique on a real render — e.g. a ref PNG in
  backend/static/refs as a data URL), paste outputs in the report. Run `backend/scripts/smoke_test.py` if it is fast.

## Task B — Frontend plumbing + UI (owner: UI agent)
Files: `frontend/src/editor/store.ts` (Edit), `frontend/src/editor/TopBar.tsx` (Edit), `frontend/src/editor/RightPanel.tsx`
(Edit), NEW `frontend/src/agent/offscreen.tsx`, NEW `frontend/src/agent/AgentQuestions.tsx`, NEW `frontend/src/agent/StepList.tsx`.
- store.ts: `ChatMsg` += `questions?: AgentQuestion[]; answered?: boolean; steps?: AgentStep[]` (import types from
  '../agent/types'); `ChatActionKind` += `'agent-prompt' | 'agent-continue'`; state += `agentMode: boolean`
  (default false, persisted in localStorage key `xero.agentMode`, all access in try/catch), `setAgentMode(on)`,
  `replaceDesign(id, design, opts?: { history?: boolean })` (history true → push the current design onto that design's
  undo past like apply does; false → silent swap; keep selection valid; re-run issues if it is the active design the
  same way apply does).
- TopBar.tsx: "Agent" toggle pill (on = filled sky/navy, off = outline) with title "Agent mode: asks when unclear,
  reviews its own work". Match existing ui.tsx styling.
- RightPanel.tsx: in `Message`, render `<StepList steps={m.steps} />` when present and `<AgentQuestions m={m} />` when
  `m.questions?.length`; `onAction`: `'agent-prompt'` → `agentPrompt(payload)`, `'agent-continue'` →
  `agentContinue(payload)` (both from '../agent/agent'); chip buttons: call `runChip` unchanged (agent wrapping happens
  inside copilot.ts, Task C).
- AgentQuestions.tsx: per question a row of single-select chips + "Other…" chip revealing a small text input; buttons
  "Continue" (enabled when every question has an answer) and "Just go — best guess" (always enabled). On submit call
  `answerQuestions(m.id, answers | null)` from '../agent/agent' (answers: question text → answer; null = best guess).
  Disabled/locked once `m.answered`. Compact, fits the 13px chat style.
- StepList.tsx: vertical list; status icon (pending ○, running Spinner from ui.tsx, done ✓ mint/green, failed ✗ rose,
  skipped – slate); label; optional right-aligned `detail`.
- offscreen.tsx: `export async function renderDesignToDataUrl(design: Design, maxSide = 768): Promise<string | null>` —
  serialized via a promise queue; mounts `<DesignStage design scale=1 detail="full">` with `createRoot` into a hidden
  fixed container far off-screen (pointer-events none); `await ensureFonts()`; waits for images (`whenImagesIdle()` from
  lib/images, then 2 rAFs, poll `pendingImageCount()` up to ~5s); `stage.toDataURL({ mimeType: 'image/jpeg', quality:
  0.85, pixelRatio: maxSide / max(w, h) })`; always unmount; return null on any failure. Look at
  `frontend/src/render/RenderRoute.tsx` and `TopBar.tsx exportPng` for how the app already waits for fonts/images.
- Verify: `npx tsc -p .` (agent.ts may not exist yet — if the only errors are imports from '../agent/agent', create
  nothing; report them) and `npx vitest run`.

## Task C — Agent brain (owner: brain agent)
Files: NEW `frontend/src/agent/agent.ts`, NEW `frontend/src/agent/review.ts`, NEW `frontend/src/agent/__tests__/agent.test.ts`,
small Edits to `frontend/src/editor/copilot.ts`.
- agent.ts exports: `agentSend(text)` (user message already pushed), `agentPrompt(text)` (pushes the user message then
  agentSend), `answerQuestions(msgId, answers | null)`, `agentContinue(pendingId)`, `withAgentReview(fn, opts)`.
  Flow per spec §2–§5d: flat-import pixel-edit pre-routing (§Settled) → `/plan` (fallback to the original non-agent
  routing on failure — implement by calling an exported `sendMessageClassic(text)` that you split out of sendMessage
  WITHOUT pushing the user message twice) → ask (assistant msg with `questions`, store pending context in a module
  Map keyed by msg id; one question round max) → act via existing copilot functions → review → suggestion chips
  (`actions` with kind 'agent-prompt'). First assistant line: "Understood: …". Multi-step: one msg with `steps`
  checklist, run sequentially via `runEdit`/`resizeActive`/`fixAll`, review once at the end (1 round).
  Creation: count ≤4 → `runConcepts(prompt, count, { brief, referenceId | reference })`; >4 → chunks of ≤4 run
  concurrently, later chunks get "avoid these headlines/templates" appended to the brief is not possible before the
  first returns — so run chunk 1, then the rest concurrently with the avoid-list (ceiling 8). Detect created designs by
  diffing `useEditor.getState().designs` ids before/after. Variations: selected ref → referenceId; upload →
  "what I see" (§5d: `api.analyze(preview)` → playback msg + 'agent-continue' action; typed reply while pending =
  correction → brief) then `fourLikeUpload(preview, count, brief?)`; active design slots → `reference: d.slots`.
  Recreate on upload → §5d then `recreateUpload`.
- review.ts: `reviewDesigns(ids, { rounds, brief, msgId })` per spec §5 + §Settled: parallel per design, 45s budget,
  snapshot + reference-equality check before apply/revert (skip if user changed it), revert via
  `replaceDesign(id, snapshot, { history: false })`, fixes via `apply(ops, { designId, autofix: true })`, brand score via
  `checkDesign`/`brandScore` from '../design' with the store manifest, render via `renderDesignToDataUrl`, critique via
  `agentApi.critique`. Trace = one assistant msg with `steps` (one per design, detail "72 → 88"), final text
  "Reviewed N designs · average X → Y · K fixes" + 'select-design' actions. Export pure helpers `combineScore(brand,
  vision)` (round(0.4*b+0.6*v)), `shouldKeep(before, after)`, `PASS_SCORE = 85` and unit-test them plus the plan
  guard logic you add client-side.
- copilot.ts Edits: split `sendMessage` into `sendMessage` (push user msg; if `agentMode` → `agentSend`; else
  `sendMessageClassic`) and exported `sendMessageClassic(t)` (the old body after the push); `export` runPixelEdit;
  wrap `runChip` so that in agent mode it runs through `withAgentReview` (new designs: 2 rounds; edit of active: 1);
  optional `brief?: string` param on `fourLikeUpload` passed to runConcepts. Re-read copilot.ts right before editing —
  another session edited it recently (countFor now 1–6, chip renamed 'Variations like this', default 3).
- Verify: `npx tsc -p .` + `npx vitest run` (B's files may land concurrently; if errors are only in B's files or
  missing B exports, report them).
