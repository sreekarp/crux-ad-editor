# Xero Copilot — an agentic, on-brand image editor

An AI copilot that lives inside an image editor. Designers can start from a blank canvas, edit an existing design,
or drop in a reference and ask for **"4 different images like this"**. Every result is a layered, editable design
that follows the Xero brand kit, not a flat picture.

## What it does

| Mode | How |
|---|---|
| Blank → design | Describe the ad in chat ("4 concepts for florists about cash flow"). The copilot writes the copy, picks layouts, photos, charms and colourways. |
| Reference → variations | Pick one of the 20 reference ads (or upload one). **Recreate** rebuilds it as editable layers instantly. "Create 4 different images like this" (any number from 1 to 6; plural requests with no number give 3) keeps its structure and varies the angle, photo and colourway. |
| Edit existing designs | Chat ("make it dark", "shorter headline", "use a photo of a baker", "make it 9:16") or edit directly: drag, resize, double-click text, layers, undo/redo. |
| Import PSD / SVG / PNG | Photoshop type layers and SVG text become **editable text**. Pixel layers and images become movable layers. PNG/JPG come in as a locked image that can be pixel-edited or recreated. |
| Brand guard | 18 brand rules checked live (palette, logo colour per background, logo pill on photos, one CTA, headline length, safe margins, Meta 9:16 safe zone, disclaimers…). The score badge shows any issues, with one-click **Fix all**. |
| Export | Pixel-exact PNG (1080×1350 / 1080×1080 / 1080×1920), high-res 2× PNG, JPG, all variations at once, or the editable design file (.json). Dropping the .json back on the canvas reopens it. |

## How it works

```
Browser (React + react-konva)                         FastAPI backend
 ├─ Editor: renders Design JSON on a Konva canvas     ├─ /api/design/concepts  DeepSeek-V4-Pro  -> Slots[]
 ├─ Design engine (pure TypeScript, 100+ tests)        ├─ /api/design/edit      DeepSeek-V4.1-Flash -> Ops[]
 │   buildDesign(Slots) -> layered Design (5 templates) ├─ /api/photo           GPT Image Flare -> photo
 │   checkDesign / autoFix (18 brand rules)             ├─ /api/analyze         DeepSeek Flash vision -> Slots
 │   applyOps(Design, Ops) (every edit, undoable)       └─ photo bank (42 pre-generated photos), brand assets
 ├─ Import: PSD (ag-psd) / SVG (sanitised) -> layers
 └─ Copilot chat: calls the API, applies ops
```

**Key design decision: the LLM never places pixels.** It fills *Slots* (template, colourway, headline, sub, CTA, hero,
charms, stat card) or emits *Ops* (`update`, `add`, `delete`, `rebuild`, `resize`, `photo`, `pixel_edit`). Layout is
deterministic code built from the 20 reference ads, so every output is on-brand and fully editable. The model only
decides what to say and which brand assets to use.

Guardrails on the copy: JSON mode plus schema validation, then one repair pass if the model copies an existing ad,
invents statistics, offers or claims, or breaks length limits. Any edit that the brand rules don't allow (red text,
a white logo on sky…) is declined with an on-brand alternative.

## Brand kit, as code
- **Palette:** navy `#000856`, blue `#1F65D6`, sky `#3ECCFF`, white, plus bloom accents mint/yellow/pink/lilac.
- **Logo:** sky or white on navy, navy on sky or white, white on blue. A pill is used over photos.
- **Blooms:** the 12 official shapes (Peace, Energy, X, Spark, Grow, Pulse, Harmony, Motion, Balance, Ease, Surge,
  Stride), scaled beyond the frame. Photos are cropped into chunky blooms or rounded frames.
- **Assets:**
  - 325 3D charms (65 types × 5 colours), sliced from the brand sheet and upscaled
  - 7 real product-UI cut-outs (phones, tablets and laptops in hands)
  - 14 illustrations
  - 18 background templates, recoloured
- **Fonts:** Barlow Condensed (headlines) and Inter (body), stand-ins for the licensed National 2. Swapping is one config line.

## Run it
Needs Python 3.12 venv in `backend/.venv` and `npm install` done in `frontend/`. API keys go in `.env` (never committed).

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1     # starts :8000 + :5173 and opens the app
```
Manual start: `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000` and `cd frontend; npm run dev`.
Checks: `cd frontend; npx tsc -p .; npx vitest run`.

## Repo map
- `frontend/src/design/` — templates, brand checker, ops engine (pure TS, tested)
- `frontend/src/editor/`, `frontend/src/canvas/` — editor UI, Konva renderer, copilot flows
- `frontend/src/import/` — PSD / SVG / raster import to editable layers
- `backend/app/` — FastAPI, prompts, validation, LLM and image clients
- `backend/data/references.json` — the 20 reference ads recreated as Slots
- `backend/scripts/` — asset pipeline (`prep_assets.py`, `fix_assets.py`), photo bank, smoke tests
- `docs/CONTRACT.md` — interfaces between the parts

## Known limitations
- The two-column comparison in reference 09 renders as standard checklist rows.
- Fonts are free stand-ins for the licensed brand fonts.
- Charm artwork is upscaled from small sources.
