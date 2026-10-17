# Demo script (~3 minutes)

Before recording: open http://localhost:5173 and do one practice pass, so caches and photos are warm. If the servers
aren't running, run `powershell -ExecutionPolicy Bypass -File .\start.ps1` from the project folder.

| Time | Show | Say |
|---|---|---|
| 0:00 | App start screen | "Designers make lots of branded images and it's easy to miss a brand rule. Xero Copilot is an AI copilot inside an image editor. Everything it makes is editable layers that follow the Xero brand kit." |
| 0:15 | **References** tab: select the "Cash flow without the suspense." ad, then type in chat **Create 4 different images like this** | "This is the brief's own example. The copilot honours whatever number you ask for: 4 here, 1 or 2 just as well. It keeps the structure, writes new headlines, picks different photos, and gets the logo and colours right." |
| 0:45 | Open one variation. In chat: **make it dark**, then **shorter headline**, then **use a photo of a baker** | "Chat edits are small, undoable operations on the layers, not a redraw. Going dark, the logo switches to sky automatically, because that's the brand rule. Photos are cropped to keep the person in frame." |
| 1:15 | Double-click the headline and type, drag a charm, press Ctrl+Z, open the **Layers** tab | "It's a real editor: every element is a layer you can move, edit and undo." |
| 1:30 | Drag the button off the edge, see the brand badge turn amber, click **Fix all**. In chat: **make the logo white** | "A brand guard checks 18 rules live and fixes them in one click. Off-brand requests get a polite no and an on-brand alternative." |
| 1:50 | Chip **Make 9:16** and the safe-zone toggle | "Reflows for Stories, keeping text inside Meta's safe zones." |
| 2:05 | Drop `frontend/src/import/__fixtures__/xero-like.psd` (or the `.svg`) on the canvas, open **Layers** | "Photoshop and SVG files come in as editable layers: the headline is real text, the button is a button." |
| 2:25 | Chat: **Give me 3 concepts for a bakery about getting paid faster** | "From a blank canvas: it writes the copy, picks layouts, photos and charms. No invented stats or offers." |
| 2:45 | **Export PNG** | "Pixel-exact 1080×1350, ready to post." |
| 2:55 | README diagram | "The LLM never places pixels. DeepSeek fills slots or emits edit operations, and layout is code built from the 20 reference ads. So every output is on-brand and editable. GPT Image Flare makes the photos, and a pre-generated photo bank keeps it fast." |

Fallbacks if the AI is slow or unavailable:
- **Recreate** on any reference is instant and doesn't use the AI.
- The **Templates** tab builds a design with one click.
- Keep talking while the 5–15 second AI step runs.
