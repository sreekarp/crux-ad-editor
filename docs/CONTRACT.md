# Contract — Xero Agentic Image Editor

Shared interfaces between the 4 workstreams. Types live in `frontend/src/types.ts` (source of truth).
Brand constants live in `frontend/src/brand.ts`. Product plan: [`PLAN.md`](PLAN.md).

## Architecture

```
Browser (React + react-konva, :5173)                     FastAPI (:8000)
 ├─ Editor: canvas renders Design JSON                    ├─ /api/design/concepts  -> DeepSeek -> Slots[]
 ├─ Design engine (pure TS, src/design/)                  ├─ /api/design/edit      -> DeepSeek -> Ops[]
 │   buildDesign(Slots) -> Design   (templates = layout)  ├─ /api/photo            -> gpt-image -> /static/gen/*.png
 │   checkDesign / autoFix          (brand rules)         ├─ /api/photos, /api/references, /api/upload, /api/analyze, /api/pixel-edit
 │   applyOps(Design, Ops)          (copilot edits)       └─ /static/* (brand assets, refs, gen, uploads)
 └─ Copilot panel: calls API, builds designs, applies ops
Vite proxies /api and /static to :8000 (same origin -> canvas export works).
```
Key rule: the LLM only fills **Slots** (copy, template, colourway, hero, charms) or emits **Ops**. Layout is code.

## Ownership (do not edit files you don't own; ask the controller)

| Workstream | Owns |
|---|---|
| A. Assets | `backend/scripts/prep_assets.py`, everything under `backend/static/brand/` |
| B. Backend | `backend/app/**`, `backend/scripts/photo_bank.py`, `backend/scripts/smoke_test.py`, `backend/requirements.txt` |
| C. Editor | `frontend/**` EXCEPT `frontend/src/design/**`, `frontend/src/types.ts`, `frontend/src/brand.ts` |
| D. Design engine | `frontend/src/design/**` (+ its tests) |
| E. Import (PSD/SVG/raster) | `frontend/src/import/**` (+ tests/fixtures); may add the `ag-psd` npm dependency |
| Controller | `frontend/src/types.ts`, `frontend/src/brand.ts`, `backend/data/references.json`, `docs/` (incl. `docs/PLAN.md`), `.env` |

Never read or print `.env` values. Backend loads it with python-dotenv from the project root (`../.env` relative to `backend/`).

## Run

- Backend: `cd backend && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000 --reload`
- Frontend: `cd frontend && npm run dev` (http://localhost:5173). Typecheck: `npx tsc -p .`. Tests: `npx vitest run`.
- Python is `backend/.venv/Scripts/python.exe` (3.12; `python` is not on PATH). Installed: fastapi uvicorn openai pillow numpy python-dotenv pydantic python-multipart httpx.
- Frontend deps (installed, do not add without asking): react 19, konva 10, react-konva 19, zustand 5, use-image, nanoid, tailwind 4, vite 8, vitest 5, TypeScript 7.
- Fonts: `@fontsource/barlow-condensed` (600/700/800) and `@fontsource/inter` (400-700), imported in `src/main.tsx`.
  Konva must not draw text before `document.fonts.load('800 40px "Barlow Condensed"')` and `document.fonts.load('600 20px Inter')` resolve.

## Asset outputs (workstream A) — URL patterns are fixed

```
/static/brand/manifest.json                         -> types.ts Manifest
/static/brand/blooms/{shape}_{colour}.png           12 shapes x 8 ColourTokens (navy blue sky white mint yellow pink lilac), tight-cropped
/static/brand/masks/{shape}.png                     12 white-on-transparent alpha masks (same crop as blooms)
/static/brand/bg/{bgId}_{colour}.png                bg_01..bg_18 x 4 CoreColours; shape coloured, rest TRANSPARENT; full template frame (not cropped)
/static/brand/charms/{type}_{colour}.png            ~65 types x 5 CharmColours (blue green yellow pink purple), tight-cropped
/static/brand/illus/{id}.png | .svg                 11 PNG + 3 SVG illustrations
/static/brand/devices/{id}.png                      7 product UI images (6 cut-outs + 1 photo)
/static/brand/logo/logo_{navy|sky|white}.png        hi-res wordmark (~760px wide), + logo_mask.png
/static/refs/ref_*.png                              20 reference ads (already there)
```
Bloom shape names (official, 06/02_blooms_set): peace energy x spark grow pulse harmony motion balance ease surge stride.
Old names -> new: leaf->peace, knot->energy, cross->x, zigzag->spark, wedge->grow, bolt->pulse, drop->harmony, swoosh->motion, wave->balance, hook->ease, curl->surge, omega->stride.

**Required charm names** (must exist; map each to the closest charm on the sheet):
`sparkle heart check checkbox hourglass percent coin money mug gift bulb pie bars chat plane thumbs calendar bell clock shield trophy lock magnifier card bank globe folder laptop phone`
Other sheet charms: give short lowercase snake_case names.

Device ids: `device_tablet_kitchen` (photo, not cut-out), `device_phone_hand_payments`, `device_phone_hand_balance`,
`device_laptop_overview`, `device_laptop_welcome`, `device_tablet_hands_account`, `device_tablet_hands_payments`.
Illustration ids: `illus_infinity_phone_{blue|sky}`, `illus_loop_bell_{blue|sky}`, `illus_loop_coins_{blue|sky}`, `illus_wave_bulb_{blue|sky}`,
`illus_wave_coin_{blue|sky}`, `illus_wave_invoice_blue`, `illus_vacation`, `illus_tax_return`, `illus_anywhere_access` (SVGs).

## Backend API (workstream B)

All JSON. Errors: HTTP 4xx/5xx with `{"detail": "..."}`.

| Method + path | Request | Response |
|---|---|---|
| GET `/api/health` | – | `{ok, models:{pro, flash, image}, keys:{pro:bool, flash:bool, openai:bool}}` |
| GET `/api/references` | – | `Reference[]` (from `backend/data/references.json`; url = `/static/refs/<file>`) |
| GET `/api/photos` | – | `PhotoBankItem[]` (from `backend/static/gen/bank/bank.json`) |
| POST `/api/design/concepts` | `{prompt, count: 1-4, referenceId?: string, reference?: Slots, size:{width,height}, brief?: string}` | `{reply: string, concepts: Slots[]}` |
| POST `/api/design/edit` | `{message, design: DesignSummary, slots?: Slots, history?: {role:'user'\|'assistant', content}[]}` | `{reply: string, ops: Op[]}` |
| POST `/api/photo` | `{prompt, tag?: string, orientation?: 'landscape'\|'square'\|'portrait', quality?: 'low'\|'medium'\|'high'}` | `{url, w, h}` |
| POST `/api/upload` | multipart `file` | `{url, w, h}` (saved to /static/uploads) |
| POST `/api/analyze` | `{url}` | `{method: 'vision'\|'ocr'\|'none', slots?: Partial<Slots>, texts?: string[], palette?: string[]}` |
| POST `/api/pixel-edit` | `{url, prompt}` | `{url, w, h}` |

Concepts: 4 concepts must differ (template/colourway/hero/headline angle). Validate every Slots with pydantic
(enums from types.ts), clamp lists (charms <= 3, items <= 3), fix invalid enums to defaults instead of failing.
Edit: Ops validated with pydantic; unknown layer ids dropped. Prefer `rebuild` for global changes (colourway, template, size)
and `update` for local ones (text, colour, position).
LLM: DeepSeek-V4-Pro for concepts, DeepSeek-V4.1-Flash for edits (fallback to the other on error/timeout).
`response_format={"type":"json_object"}` if accepted, else parse the first JSON object from the text. One repair retry
with the validation error. 429 -> exponential backoff with jitter (max 4 tries).
Images: model from `IMAGE_MODEL` (gpt-image-2.5-flare). Photos only: append "no text, no logos, no watermarks, no UI screens".
Sizes: landscape 1536x1024, square 1024x1024, portrait 1024x1536.

Photo bank tags (PHOTO_TAGS): `florist cafe bakery boutique maker woodworker tradie builder beekeeper foodtruck salon farmer homeoffice laptop`.
Photo style: "candid natural photo, warm daylight, real small-business owner at work, smiling, shallow depth of field,
authentic, editorial, no text, no logos, no screens with UI".

## Templates (workstream D) — see refs in backend/static/refs/

All coordinates are fractions; W = width, H = height. Design for 4:5 (1080x1350) first; 1:1 and 9:16 must still look right
(9:16: keep text/logo/CTA inside the Meta safe zone, `SAFE.story` in brand.ts). Margin m = 0.06W.
Headline: font 'headline', weight 800, lineHeight ~0.98, letterSpacing -0.005*fontSize, sentence case.
Body/sub: 'body' 500. CTA: button, fontSize ~0.03W, weight 700 (renderer), height ~0.075W, padding-x ~0.035W,
cornerRadius ~0.012W (rounded rect, NOT a full pill). Logo aspect = manifest.logo w/h (~3.5:1), width ~0.27-0.30W.
Text heights must be measured (estimate lines: avg char width ~0.42*fontSize for Barlow Condensed 800, ~0.55*fontSize for Inter)
so cards/stacks never overflow.

1. **card** (light|dark|blue) — refs 01, 05_5552, 05_d990, 06, 08, 11, 12, 13, 15, 17.
   Background colour; hero photo full-bleed in the lower ~60% (photo layer, mask null, cornerRadius 0) with big bloom(s)
   of the background colour layered over the photo's top edge so the boundary is organic; white rounded card on top
   (x m, y m, w 0.88W, r ~0.045W, height = content + padding): headline (navy), optional sub, CTA (+ optional disclaimer
   right-aligned on CTA row). Logo on the bloom area to the right below the card (navy on sky, sky/white on navy,
   white on blue) + optional tags strip below the logo. 1-2 charms overlapping card corner / photo edge. Optional stat card
   on the photo (lower right). No-photo variant (hero none): big blooms + charm cluster instead (refs 01, 05_5552).
2. **bold** (dark|blue) — refs 02, 04, 07, 10. White headline top-left (large, ~0.10W); CTA under headline;
   hero bottom-right bleeding off the edges: photo masked by a chunky bloom, or illustration, or device cut-out;
   a big blue (on navy) / sky (on blue) bloom behind the hero; logo bottom-left (sky on navy, white on blue); charms around hero;
   optional stat card overlapping the hero's left edge.
3. **checklist** (dark) — ref 03. Navy bg + big blue bgshape covering the lower part; centred white headline; 3 white
   fully-rounded rows (height ~0.12W) each with a green 'check' charm + navy condensed text; CTA bottom-left (sky),
   logo bottom-right (white); 1-2 charms.
4. **split** — ref 14. Sky bg; navy bloom/bgshape covering the left/top diagonal; headline (white, on navy, top-left)
   + headline2 (navy, on sky, top-right, right-aligned); device cut-out (phone in hand) centre-right; tags + navy logo
   bottom-left; white CTA (navy text) bottom-right; heart charm.
5. **offer** (light) — refs 16, 18, 19. Sky bg; navy headline top-left; sub; navy CTA (white text); disclaimer
   ("Terms apply."); hero (photo masked by a chunky bloom, or device) bottom-right bleeding off edges with a white/blue
   bloom behind; navy logo bottom-left (+ tags above it); 2-3 charms around hero; optional stat card.

Colourways: light = sky bg, navy text; dark = navy bg, white text; blue = blue bg, white text. Cards are always white
with navy text. ctaStyle default: sky on dark/blue, navy on light, sky on the white card.

## Brand checker rules (workstream D)

palette (only ColourTokens; backgrounds core only) · text-colour (navy/white only) · contrast (text colour must suit
what's behind it) · logo-count (exactly 1) · logo-colour (LOGO_ON) · logo-pill (logo overlapping a photo/device
needs a pill: LOGO_PILLS) · logo-aspect (w/h within 5% of manifest) · cta-count (exactly 1 button) · headline-length
(<= 10 words) · headline-punctuation (ends with . ? or !) · safe-margin (text/logo/cta inside 6%) · safe-zone-916
(9:16 only) · min-font-size (>= 24px at 1080w) · disclaimer (offer words: %, £ $ R amounts, free, voucher, off, * ->
needs a disclaimer layer) · photo-treatment (photo needs a mask or cornerRadius >= 0.02W unless it is a full-bleed
background photo touching 2+ edges) · bloom-colours (<= 3 distinct bloom colours) · aspect (logo/charms/devices not
stretched) · off-canvas (text must be fully on canvas). Every fixable rule returns `fix` Ops.

## File import (workstream E) — `frontend/src/import/index.ts`

Uploads accept PNG/JPG/WEBP, SVG and Photoshop PSD (user requirement). The editor calls only
`importFile(file): Promise<ImportResult>` and `ACCEPTED_FILES`. `ImportResult = {kind, design, previewUrl, notes}`:
`design` is editable (scaled to 1080 wide): PSD type layers and SVG `<text>` -> TextLayer (colour snapped to navy/white,
font 'headline' for condensed/heavy faces else 'body'); PSD pixel layers / SVG `<image>` -> ImageLayer; remaining SVG
vector art -> one ImageLayer rendered from the SVG minus text/images; bottom-most background layer role 'flat-image'.
`previewUrl` = flattened PNG uploaded via /api/upload (feed it to /api/analyze for "4 like this" / "recreate").
Layer images are uploaded via /api/upload (no data URLs in the design JSON).

## Ops semantics (workstream D implements `applyOps`)

`update` merges props (never changes `kind`/`id`) · `add` inserts (default top) · `delete` removes · `reorder` moves ·
`rebuild` merges Partial<Slots> into design.slots and calls buildDesign at the current size, then carries over user
edits where the role still exists (text of headline/sub/cta, photo src) unless the rebuild changes that slot ·
`resize` = rebuild at the new size (if slots) else proportional scale · `photo` / `pixel_edit` -> returned in `pending`.
