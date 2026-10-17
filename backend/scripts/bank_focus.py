"""Find the subject (main face) position of every photo-bank image, so crops into blooms keep the person in view.

Adds "focus": [x, y] (fractions of width/height) to static/gen/bank/bank.json via DeepSeek Flash vision.
Idempotent: photos that already have a focus are skipped.
usage: backend/.venv/Scripts/python.exe backend/scripts/bank_focus.py
"""
import asyncio
import base64
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.config import flash_client, settings  # noqa: E402
from PIL import Image  # noqa: E402

BANK = ROOT / "static" / "gen" / "bank" / "bank.json"
PROMPT = ('This is a photo of a small-business owner. Return JSON only: {"x": number, "y": number} = the centre of the '
          "main person's face as fractions of the image width (x, from the left) and height (y, from the top), 0-1. "
          "If there are two main people, return the point midway between their faces.")


def data_url(path: Path) -> str:
    im = Image.open(path).convert("RGB")
    im.thumbnail((640, 640))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


async def locate(item: dict, sem: asyncio.Semaphore) -> None:
    path = ROOT / item["url"].removeprefix("/")
    async with sem:
        for attempt in range(3):
            try:
                resp = await flash_client.chat.completions.create(
                    model=settings.flash_model, timeout=40, max_tokens=200, temperature=0,
                    response_format={"type": "json_object"},
                    messages=[{"role": "user", "content": [
                        {"type": "text", "text": PROMPT},
                        {"type": "image_url", "image_url": {"url": data_url(path)}}]}])
                text = resp.choices[0].message.content or ""
                d = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
                x, y = float(d["x"]), float(d["y"])
                if x > 1 or y > 1:  # model answered in pixels of the 640px thumbnail
                    x, y = x / 640, y / (640 * 2 / 3)
                item["focus"] = [round(min(max(x, 0.0), 1.0), 3), round(min(max(y, 0.0), 1.0), 3)]
                print(f"{item['url'].rsplit('/', 1)[-1]}: {item['focus']}")
                return
            except Exception as e:  # noqa: BLE001
                print(f"{item['url']}: attempt {attempt + 1} failed: {str(e)[:120]}")
                await asyncio.sleep(2 * (attempt + 1))


async def main() -> None:
    bank = json.loads(BANK.read_text(encoding="utf-8"))
    todo = [b for b in bank if "focus" not in b]
    sem = asyncio.Semaphore(6)
    await asyncio.gather(*(locate(b, sem) for b in todo))
    BANK.write_text(json.dumps(bank, indent=1), encoding="utf-8")
    print(f"done: {sum('focus' in b for b in bank)}/{len(bank)} photos have a focus point")


if __name__ == "__main__":
    asyncio.run(main())
