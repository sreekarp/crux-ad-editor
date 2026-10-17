"""Find the essential subject region of every photo-bank image, so crops into blooms/frames keep the whole subject.

Adds "box": [x0, y0, x1, y1] (fractions of width/height) to static/gen/bank/bank.json - and "focus" when missing - via
the same Flash vision call the app uses (app.images.locate_subject). Idempotent: photos that already have a box are
skipped. Merges into a fresh read of bank.json before writing, so concurrent edits to other fields are kept.
usage: backend/.venv/Scripts/python.exe backend/scripts/bank_box.py
"""
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.images import locate_subject  # noqa: E402

BANK = ROOT / "static" / "gen" / "bank" / "bank.json"


async def locate(item: dict, sem: asyncio.Semaphore, found: dict) -> None:
    async with sem:
        for attempt in range(3):
            d = await locate_subject(item["url"], timeout=40)
            if d.get("box"):
                found[item["url"]] = d
                print(f"{item['url'].rsplit('/', 1)[-1]}: box={d['box']} focus={d.get('focus')}")
                return
            print(f"{item['url']}: attempt {attempt + 1} failed")
            await asyncio.sleep(2 * (attempt + 1))


async def main() -> None:
    bank = json.loads(BANK.read_text(encoding="utf-8"))
    todo = [b for b in bank if "box" not in b]
    found: dict = {}
    sem = asyncio.Semaphore(6)
    await asyncio.gather(*(locate(b, sem, found) for b in todo))
    bank = json.loads(BANK.read_text(encoding="utf-8"))  # fresh read: merge only our fields
    for b in bank:
        d = found.get(b.get("url"))
        if d and "box" not in b:
            b["box"] = d["box"]
            if "focus" not in b and d.get("focus"):
                b["focus"] = d["focus"]
    BANK.write_text(json.dumps(bank, indent=1), encoding="utf-8")
    print(f"done: {len(found)} new boxes; {sum('box' in b for b in bank)}/{len(bank)} photos have a box")


if __name__ == "__main__":
    asyncio.run(main())
