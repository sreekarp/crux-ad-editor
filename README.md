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
 │                                                     │    (+ uploaded image: DeepSeek Flash vision first)
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

### Uploads and "variations like this"
1. **Upload.** The paperclip, or a drop on the chat, imports the file as a new design. The importer also uploads a
   flattened PNG preview to `/static/uploads/`. Nothing is attached to the chat message itself: the app remembers the
   upload on the active design, and the planner gets only a `hasUpload` flag.
2. **Read.** "Variations like this" (typed, or the button) sends the preview to `/api/analyze`. DeepSeek Flash vision
   turns it into Slots (template, colourway, copy, hero, stat). The agent plays back what it saw, and the user
   confirms or types a correction.
3. **Generate.** `/api/design/concepts` gets the reference Slots **plus the uploaded image** (`referenceImage`).
   DeepSeek Pro is text-only, so the image call runs on Flash, capped at 60 s. If it errors, times out or returns
   invalid concepts, the backend falls back to the text-only Pro call (Slots only). The backend log shows which path
   ran: `concepts: built with the reference image (flash)` or `…falling back to text-only`.
4. **Build.** The same copy checks, claim scrubbing and "keep the reference's structure" rules run on either path.
   Code then lays out the layers, and photos come from GPT Image or the photo bank. The upload's pixels are never
   reused in the output.

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

### One command
```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1             # set up if needed, start both servers, open the app
powershell -ExecutionPolicy Bypass -File .\start.ps1 -Restart    # stop the running servers first (picks up code changes)
powershell -ExecutionPolicy Bypass -File .\start.ps1 -NoBrowser  # same, without opening the browser
```
[`start.ps1`](start.ps1) does everything, in order:
1. If there is no `.env`, it creates one from `.env.example` and stops so you can fill in the keys.
2. It creates `backend/.venv` with Python 3.12 (using `uv` if installed, else `py -3.12 -m venv`) and installs
   `backend/requirements.txt`.
3. It runs `npm install` in `frontend/`.
4. It starts the backend (FastAPI, http://localhost:8000) and the frontend (Vite, http://localhost:5173), each in its
   own window. Close a window to stop that server.
5. It waits until both answer, reports any empty API keys, then opens the app.

Steps 2 and 3 run only on the first run, or when `requirements.txt` / `package-lock.json` change (a hash stamp is
kept in `.venv` and `node_modules`). Servers that are already running are left alone unless you pass `-Restart`.

### Prerequisites
- Windows 10/11 with Windows PowerShell 5.1. The script uses only built-in cmdlets.
- Python 3.12 (`py -3.12`) or [uv](https://docs.astral.sh/uv/). Tested with Python 3.12.10 and uv.
- Node.js 22 or newer with npm. Tested with Node 24.14.1 and npm 11.11.0.

### Libraries (kept in the repo, versions pinned)
| Part | File | What's in it |
|---|---|---|
| Backend | [`backend/requirements.txt`](backend/requirements.txt) | `fastapi` 0.143.3, `uvicorn` 0.54.0, `openai` 3.33.0 (DeepSeek and GPT Image clients), `pillow` 13.0.0, `numpy` 2.5.4, `python-dotenv` 1.2.4, `pydantic` 2.14.1, `python-multipart` 0.0.32 (uploads), `httpx` 0.28.1 |
| Frontend | [`frontend/package.json`](frontend/package.json) + `package-lock.json` | React 19, Konva / react-konva, zustand, ag-psd (PSD import), Fontsource fonts; dev: Vite 8, TypeScript, Tailwind 4, Vitest |

These files match what is installed in the working environment: every package in `requirements.txt` is installed at
exactly that version. The venv also holds transitive dependencies (starlette, anyio, …) and a few optional uvicorn
extras (`watchfiles`, `websockets`, `httptools`) that the app doesn't need. To reproduce by hand:
`uv venv --python 3.12 backend/.venv; uv pip install --python backend/.venv/Scripts/python.exe -r backend/requirements.txt`
and `cd frontend; npm install`.

### API keys (`.env` at the project root, never committed)
Copy `.env.example` to `.env` and fill in:

| Variable | Used for |
|---|---|
| `DEEPSEEK_PRO_KEY`, `DEEPSEEK_PRO_BASE_URL`, `DEEPSEEK_PRO_MODEL` | Concepts and planning (text only) |
| `DEEPSEEK_FLASH_KEY`, `DEEPSEEK_FLASH_BASE_URL`, `DEEPSEEK_FLASH_MODEL` | Quick edits, image analysis, image-grounded variations |
| `OPENAI_API_KEY`, `IMAGE_MODEL` | GPT Image photos and pixel edits |
| `PRO_TIMEOUT`, `FLASH_TIMEOUT`, `IMAGE_TIMEOUT` (optional) | Per-call timeouts in seconds (defaults 120 / 60 / 200) |

`http://localhost:8000/api/health` lists any missing keys.

### Manual start and checks
- Backend: `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000` (no auto-reload: restart it,
  or run `start.ps1 -Restart`, after backend changes)
- Frontend: `cd frontend; npm run dev`
- Checks: `cd frontend; npx tsc -p .; npx vitest run`

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
- DeepSeek Pro can't take images, so image-grounded variations are written by Flash. Flash is a weaker copywriter
  than Pro, but the same copy and brand checks apply. If Flash fails, the app falls back to Pro without the image.
