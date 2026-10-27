# Xero Agentic Image Editor — GetCrux Hackathon (17 Oct 2026)

Deadline 18:15 sharp. Solo. Judged on: 1) output quality 2) code understanding/system design 3) speed + features 4) UI/UX 5) presentation.
Demo: live + recorded backup (record before 18:00).
Brief calls the refs "Reference recreations" -> expect judges to try "recreate this" / "4 like this" on the refs AND on an unseen image.

## Product
AI copilot inside an image editor. Designs are LAYERS on an editable canvas (not flat images).
Modes: blank -> design | edit existing design (chat) | reference -> "4 different images like this".
Inputs: PNG/JPG/WEBP, SVG and Photoshop PSD (user requirement, 13:45). SVG/PSD import as EDITABLE elements, never flat:
PSD type layers + SVG <text> -> editable text layers; PSD pixel layers + SVG <image> -> movable image layers; leftover SVG vector art -> one movable image layer.
Uploaded flat PNG/JPG: if image analysis works, recreate as editable layers (text -> text layers in brand font, photo region -> image layer, colours snapped to palette).
Otherwise pixel-only editing via GPT Image edit (locked image layer; brand layers can go on top).
Core design rule: the LLM fills SLOTS (template, colourway, copy, hero, charms); code does layout. The LLM never places pixels, so every output stays on-brand.

## Stack
- frontend/: React + Vite + TS + react-konva + Tailwind. Design = JSON, canvas just renders it.
  - Vite proxy /api and /static -> :8000 (same origin). Cross-origin images taint the canvas and break PNG export.
  - Fonts self-hosted (woff2 in frontend/public/fonts). await document.fonts.load(...) before first Konva draw, else text wraps with the fallback font.
- backend/: Python FastAPI, openai SDK (AsyncOpenAI). Serves backend/static/ (brand assets, refs, gen, uploads).
  - `python` is NOT on PATH (only `py` launcher + uv). `uv venv --python 3.12` then `uv pip install fastapi uvicorn openai pillow numpy python-dotenv pydantic`.
- Keys: .env at PROJECT ROOT (already created); load with python-dotenv using an explicit path. NEVER commit.
  .gitignore must also exclude the brief PDF (it contains the keys). Check `git status` before the first commit.
- LLM: DeepSeek-V4-Pro (4-variation planning) + DeepSeek-V4.1-Flash (quick edits), OpenAI-compatible Azure endpoints (see brief PDF).
  429 = retry w/ backoff + jitter. Measure latency of both first; set timeouts + max_tokens.
- Images: OPENAI_API_KEY, IMAGE_MODEL=gpt-image-2.5-flare (= "GPT Image Flare"; quality low|medium|high|max|auto).
  Photos only, never text/logos/app UI. Test latency first; generate in parallel. One shared key -> expect rate limits.
- Agent output: ask LLM for JSON {"reply": str, "ops": [...]} (don't depend on tool-calling support).
  Use response_format json_object if the Azure DeepSeek endpoint accepts it. Validate with pydantic; on failure retry once, feeding back the validation error.
  Ops: create(template,colourway,slots) | update(id,props) | add(layer) | delete(id) | photo(id,prompt) | pixel_edit(id,prompt).
- Vision decision tree (test in the first 15 min):
  1) DeepSeek accepts image_url -> use it.
  2) else ask organisers if the OpenAI key may be used for a vision chat model.
  3) else rapidocr-onnxruntime (OCR headline/CTA + boxes) + Pillow colours snapped to palette + ask user to confirm.
  The 20 refs always work via the hand-written reference library below.

## Brand (enforce in code — brand checker with auto-fix + badge)
Core: navy #000856 (text/dark bg/logo), blue #1F65D6, sky #3ECCFF, white #FFFFFF. Backgrounds = these 4 only (true for all 20 refs).
Bloom accents (exact, from bloom sheet): mint #6AEAAA, yellow #FDCC08, pink #FF719B, lilac #CF89FE -> blooms/charms/illustrations only; max 3 bloom colours per design.
Illustration-only extras: #2DB879 #E99000 #F14B6A #009DEB #9FE5FF #184390. (#9747FF = Figma frame lines in the sheets, NOT a brand colour.)
Text colour: navy or white only (WCAG AAA, per accessibility slide).
Ref screenshots are colour-shifted (blue ~#2458C4, sky ~#68C8F8/#80C4F4). Brand-kit hex wins; always snap sampled colours to the nearest token.
Fonts (default, 1-line config swap): headline "Barlow Condensed" 700-800, line-height ~1.0, tracking -0.5%; body/CTA "Inter" 500-700.
Real brand font = Klim National 2 (licensed) — asking organisers.
Logo (05_Logo_Guidelines): wordmark only; never stretched, rotated or recoloured off-list.
- Colourways: on navy -> SKY (primary) or white | on sky -> navy | on white -> navy | on blue -> white.
- Over photos or busy backgrounds -> THE PILL (navy pill + sky logo | sky pill + navy logo | white pill + navy logo).
- Co-brand: "xero + partner" with a "+"; partner logo never visually larger, aligned to the wordmark height.
Photos (06 slides) — two approved treatments:
- (a) cropped into a bloom (campaign/top-funnel); the subject may subtly break the mask.
- (b) rounded-rect photo frame with a bloom layered behind it, breaking the frame.
- Also used in refs: full-bleed photo with big blooms layered over it (card refs).
- Never a plain square-cornered rectangle.
Blooms: scale beyond the frame edge (bleed) for movement; layer for depth; keep aspect (no squash). Patterns only with intent, max 3 colours.
Copy: headline <= ~10 words, sentence case, ends with "." or "?", 2-3 lines, punchy; exactly one CTA.
Add a disclaimer ("Terms apply." / "*Source...") when copy has an offer, %, price or asterisk.
Layout: text inside a 6% margin; min font size (body >= 24px at 1080 wide).
9:16 Meta safe zone (17_Meta_Asset_Safe_Zones): top 14%, bottom 35%, sides 6%, and keep the bottom-right 21%w x 40%h clear.

## Assets — backend/static/brand/
Asset prep script (scripts/prep_assets.py, ~15 min). Run it BEFORE writing code that references asset names.
1. Blooms: rename to official names (06/02_blooms_set).
   leaf->peace, knot->energy, cross->x, zigzag->spark, wedge->grow, bolt->pulse, drop->harmony, swoosh->motion, wave->balance, hook->ease, curl->surge, omega->stride.
   Store each as one white alpha MASK (2x upsample + smooth threshold -> crisp at 1080+). Tint at render time to any of the 7 bloom colours (navy, blue, sky, mint, yellow, pink, lilac); the 08_Blooms sheet shows all 12 x 7.
   Photo masks = chunky shapes only: harmony, peace, balance, x, energy. Thin shapes (spark, pulse, surge, stride, motion, ease, grow) are decoration only.
2. Background templates bg_01..18 (1:1 = 01,02,03,05,06,08,09,10,11; 9:16 = 04,07,12-18) -> tintable masks too (e.g. blue curve on sky, sky on navy).
   No 4:5 or 16:9 files exist (16:9 only on the slide) -> cover-crop the mask, or build the bg from oversized blooms.
3. Logo: the 210x60 files are too low-res. Extract a hi-res mask (~760px wide) from 05_Logo_Guidelines/01 (navy wordmark on sky; threshold on darkness).
   Save as logo_mask.png; tint navy/sky/white. Pill = rounded rect + logo.
4. Charms: slice the full charm sheet 22_Charms/08 (identical to 07_Illustration/05_Charms.png, 2205x4466).
   ~65 types x 5 colourways (blue, green, yellow, pink, purple), ~300px each.
   Method: drop #9747FF dashed frames -> connected components -> crop. Name types by eye (check, thumbs, sparkle, receipt, padlock, bar_chart, plane, coin, money, percent, mug, pointer, gauge, battery, link, bell, timer, chat, heart, hourglass, alarm, bulb, calendar, magnifier, trophy, folder, shield, bank, gift, globe, camera, parachute, keys, card...).
   These ARE the 3D charms used in the refs (heart, sparkle, mug, gift, money, coin %, bulb, hourglass, pie/bar chart, chat bubbles, plane). They replace the 9 tiny 60-90px charms.
5. Devices from 11_Product_UI_References (7 files, real Xero UI). Downscale to <=1600px, keep alpha:
   - device_tablet_kitchen (01, full photo with background)
   - device_phone_hand_payments (02), device_phone_hand_balance (05)
   - device_laptop_overview (03), device_laptop_welcome (04_6c44)
   - device_tablet_hands_account (04_bb02), device_tablet_hands_payments (06)
   Use them for product concepts instead of AI images (refs 05_d990, 10, 13, 14, 16, 19). Instant, no generation, no fake UI text.
6. Illustrations: add the 3 SVGs from 07_Illustration (vacation, tax_return, anywhere_access). They are vector, with pink/sky ribbons like ref 02.
   Keep the 11 PNGs (sky/blue ribbon variants, drawn for navy backgrounds).
7. manifest.json: every asset with id, type, tags, colour, natural size, aspect. It feeds the LLM prompt and the brand panel.
- Reference ads: backend/static/refs/ref_*.png (20).

## Templates (normalized coords so 1:1 / 4:5 / 9:16 work. Default 1080x1350 = the refs' 4:5)
1. card (light|dark|blue) — refs 01, 05_5552, 05_d990, 06, 08, 11, 12, 13, 15, 17.
   - Background: bg colour + big blooms bleeding off the edges; optional full-bleed photo in the lower ~60% with sky/blue bloom shapes over it.
   - White rounded card at the top (r ~4% of width, flat, no shadow): navy headline, optional sub, CTA (+ optional "Terms apply." on the right).
   - Logo on a bloom right of / below the card (+ optional tags strip); 1-2 charms on a card corner or photo edge; optional stat card on the photo.
   - No-photo variant uses a charm cluster instead (01, 05_5552).
2. bold (dark|blue) — 02, 04, 07, 10.
   - White headline top-left (or centred, as in 02); CTA under the headline or bottom-left.
   - Hero = photo in a bloom bleeding bottom-right | illustration centre | device cutout; big blue bloom behind.
   - Logo at the bottom (sky on navy, white on blue).
3. checklist (dark) — 03: centred white headline; 3 white rounded rows (green check charm + navy condensed text); CTA bottom-left, logo bottom-right.
   Variant comparison (blue) — 09: two white cards, "Other software" (pink x icons) vs "Xero" (green checks); tags strip; navy footer band.
4. split (sky+navy) — 14: navy bloom diagonal over sky; headline 1 white on navy + headline 2 navy on sky; device cutout centre-right; tags + navy logo bottom-left; white CTA bottom-right.
5. offer (light) — 16, 18, 19: sky bg; navy headline + sub + navy CTA + "Terms apply."
   Hero photo/device in a round bloom bleeding bottom-right; navy logo bottom-left; 2-3 charms around the hero; optional stat card/tags.
Shared components (first-class layer kinds the LLM can add):
- headline, sub, disclaimer, charm, bloom, masked photo, device, illustration.
- cta: 3 colourways — sky + navy text | navy + white text | white + navy text. Corner radius ~8px at 1080 (refs use rounded rectangles, not full pills).
- logo / logo_pill.
- tags strip: "✓ ACCOUNTING ✓ PAYMENTS ✓ PAYROLL ✓ ANALYTICS" (green check bullets, condensed caps, 1x4 or 2x2).
- stat card: label + value + sparkline | "Payment Received" + green check | "Revenue" area chart.
Colourways: light (sky bg, navy text) | dark (navy bg, white text) | blue (#1F65D6 bg, white text) | split.

## Reference library (references.json: template / colourway / headline / CTA / extras)
01 card light, no photo · "Get a Xero Coach. Get ahead." / Get a Xero Coach today [navy CTA] · chat-bubble charms · blue bloom top-left · tags beside navy logo
02 bold dark, centred · "One platform. Every tool." / Grow with Xero · illustration (pink ribbon + laptop) · blue bloom lower half · white logo
03 checklist dark · "Payroll? Automated. Super? Sorted." rows Payroll/Super/Me time / Try Xero · sparkle + mug charms · white logo
04 bold dark · "Data in. Doubt out." / Try Xero today · photo (maker, smiling) in bloom bottom-right · stat "Cashflow £12,500" + sparkline · coin % charm · SKY logo
05_5552 card dark, no photo · "93% of customers say Xero is easy to use.*" / Get 90% off for 6 months [navy CTA] · heart charm · sky logo · "*Xero AU Survey, May 2024. Terms apply."
05_d990 card light · "Suddenly you're fluent in finance." / Try Xero for free + "Terms apply." · phone-in-hand photo · sparkle charm
06 card light · "Remember why you started? We do." / Find out more · florist photo · heart charm
07 bold blue · "Up and running in under 4 hours." / Make the switch · man on phone at home, photo cut by blue bloom edge · check charm · white logo on blue bloom
08 card light · "Cash flow without the suspense." sub "See what's coming in. Plan what's going out." / See how with Xero · clothing-store owner · stat "Cash flow R12,500" · sparkle
09 comparison blue · "It's not you. It's your software." Other software vs Xero / Switch to Xero · sparkle · white tags · sky logo on navy band
10 bold dark · "Get ahead of what's coming." / Download the playbook · hands holding tablet in bloom · sparkle, hourglass, bulb charms · sky logo
11 card light · "Paid. No invoice chasing needed." / Learn more · florist photo · stat "Payment Received R250.00" + green check
12 card light · "Run your business, not your books." / Find out more · two women + dog at home · sparkle
13 card light · "Clear setup, so you can clear your schedule." / Get matched with a Xero Coach · laptop on woodworking bench · tags under logo
14 split · "Other software holds you back." (white on navy) + "Xero holds your hand." (navy on sky) / Switch to Xero [white CTA] · phone-in-hand cutout · heart · tags · navy logo
15 card blue · "Xero gets your Sundays back." / Switch to Xero · food-truck owner · mug + hourglass charms · white logo + white tags on blue bloom
16 offer light · "Get a £25 Amazon voucher*." sub "Send your first MTD for Income Tax quarterly update to HMRC through Xero by 7 August. Terms apply." / Sign up [navy CTA] · phone-in-hand in round bloom · gift, money, sparkle
17 card light · "Run your business, not your books." / Find out more · builder holding plans · sparkle + check
18 offer light · "Hit your software's ceiling? Say hi to Xero." / Switch to Xero [navy CTA] · beekeeper in bloom · stat "Revenue" chart · bar chart, plane, sparkle · tags · navy logo
19 offer light · "24/7 support that gets you sprinting." / Get your first month free [navy CTA] + "Terms apply." · laptop + hands in bloom · pie chart + sparkle
Photo style prompt: candid natural photo, warm daylight, real small-business owner at work (florist, cafe, maker, tradie, beekeeper, builder, food truck, clothing store), smiling, shallow depth of field, no text, no logos, no screens with UI.
Markets in refs: UK (£, HMRC/MTD), AU ("Super", AU survey), ZA (R) -> cheap P1 feature: localise currency/terms per market.

## P0 features
1 canvas editor (select/move/resize/rotate via Konva Transformer, inline text edit, delete, layers, undo/redo, export PNG at full res)
2 brand kit panel (assets click/drag from manifest, locked palette + fonts)
3 chat copilot editing canvas
4 blank -> design (template pick + fill)
5 reference -> 4 editable variations side by side. Code enforces diversity (different template/colourway/hero/bloom/headline angle).
6 photo masked into bloom. Layer JSON keeps {photoSrc, mask, offset, scale} so it stays editable; the offscreen canvas only renders (draw photo cover-fit, then destination-in with the bloom mask). Double-click to pan/zoom inside the bloom.
7 brand checker + auto-fix + badge (rules above; highlight the offending layer on canvas)
8 pre-generated photo bank: ~16-24 photos (subjects above, 1024x1536, tagged), generated in the background right after the API test.
  Variations become instant; live generation only on request.
P1 if time: AI self-review (render PNG -> vision critique, only if vision works), 1:1/9:16 reflow with safe-zone overlay, market localisation, auto logo pill over photos, subject breaking the mask (transparent cut-out on top), co-brand lockup. Cut: history, MCP server.

## Schedule
12:55-13:20 API smoke tests (DeepSeek Pro/Flash JSON mode + latency, vision test, gpt-image-2.5-flare + latency) + asset prep script; start photo bank in background
13:20-14:15 skeleton (canvas renders card template with real assets) | 14:15-14:45 lunch
14:45-15:30 chat copilot + blank->design | 15:30-16:15 4 variations | 16:15-16:45 brand checker | 16:45-17:15 polish + split/offer templates
17:15-17:45 test runs, cache good outputs | 17:45-18:05 record | 18:05-18:15 submit

## Review log (12:50)
Changed from v1: image model id, logo colourways + pill + hi-res logo, official bloom names + tint masks, 4 bloom accent colours, photo rule (2 treatments),
ref 14 relabelled split (not checklist), +comparison/offer details, tags strip/stat card/disclaimer/CTA colourways, full Meta safe zone,
assets previously unused (charm sheet, 7 product UI cut-outs, 3 SVGs, safe zones, guideline slides), vision fallback tree, proxy/fonts/JSON-mode gotchas, photo bank, schedule.
