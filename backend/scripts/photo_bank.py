"""Pre-generate the photo bank: landscape 1536x1024 photos per PHOTO_TAG -> static/gen/bank/{tag}_{n}.png + bank.json.

Usage (from backend/):
  .venv/Scripts/python.exe scripts/photo_bank.py --per-tag 2 --concurrency 4 --quality medium [--tags florist cafe]
Resumable: existing files are skipped (and re-registered in bank.json if missing there).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

from app import images  # noqa: E402
from app.assets import PHOTO_TAGS  # noqa: E402
from app.config import BANK_DIR, BANK_JSON  # noqa: E402

# Different person + setting per variant (variant n uses VARIANTS[tag][(n-1) % len]).
VARIANTS: dict[str, list[str]] = {
    "florist": [
        "smiling Asian woman florist in her 30s arranging a bouquet of peonies at the counter of her flower shop",
        "cheerful Black man florist in a green apron carrying buckets of fresh tulips outside his corner flower shop",
        "older white woman florist with grey hair wrapping a bouquet in brown paper in a sunlit florist studio",
    ],
    "cafe": [
        "smiling Latina cafe owner in her 30s handing a flat white across the counter of her cosy neighbourhood cafe",
        "young bearded man barista laughing while tamping espresso behind a busy cafe counter, chalkboard blurred",
        "South Asian woman cafe owner in her 50s arranging pastries in the window display of her small cafe",
    ],
    "bakery": [
        "smiling baker in her 40s pulling a tray of golden sourdough loaves from the oven in a small bakery",
        "young Black man baker dusting flour over croissant dough on a wooden bench in a family bakery",
        "older Italian baker with flour on his apron shaping bread rolls, morning light through the bakery window",
    ],
    "boutique": [
        "smiling woman owner folding knitwear at the counter of her independent clothing boutique",
        "stylish young man owner adjusting a jacket on a rail in his menswear boutique, warm shop lighting",
        "Black woman boutique owner in her 40s tagging new stock among colourful dresses in her shop",
    ],
    "maker": [
        "smiling woman ceramicist in her 30s glazing handmade mugs at a workbench in her pottery studio",
        "young man leather maker stitching a wallet by hand at his workshop table, tools neatly arranged",
        "Asian woman milliner shaping felt over a wooden hat block in her sunny craft studio",
    ],
    "woodworker": [
        "bearded woodworker in his 40s planing an oak plank at his bench, wood shavings curling, warm workshop light",
        "young woman carpenter measuring a table top with a pencil behind her ear in a small furniture workshop",
        "older Maori man woodworker sanding a handmade chair in his timber workshop, sawdust in the light",
    ],
    "tradie": [
        "smiling plumber in work overalls with a toolbox standing by his open work van on a suburban street",
        "young woman electrician in hi-vis checking a fuse board in a bright home renovation",
        "middle-aged Pacific Islander landscaper resting on a spade in a freshly planted garden, smiling",
    ],
    "builder": [
        "smiling builder in a work shirt holding rolled-up plans on a residential construction site",
        "woman site manager in a hard hat and hi-vis vest reviewing a clipboard beside timber framing",
        "older builder with a tool belt laughing with an apprentice on a sunny building site",
    ],
    "beekeeper": [
        "beekeeper in a veil holding up a honeycomb frame covered in bees, golden afternoon light",
        "smiling young woman beekeeper checking a hive in a wildflower meadow, veil pushed back",
        "older man beekeeper pouring honey into jars at a wooden table in his farm shed",
    ],
    "foodtruck": [
        "smiling Black man with a beard leaning on the counter of his food truck by the beach, arms crossed",
        "young Latina woman handing a taco through the window of her colourful food truck at a street market",
        "Asian man chef plating noodles inside his food truck, warm evening market lights behind",
    ],
    "salon": [
        "smiling hairdresser in her 30s styling a client's hair in a bright independent salon",
        "barber with tattoos trimming a customer's beard in a vintage barbershop, laughing",
        "Black woman salon owner arranging hair products on shelves in her airy salon",
    ],
    "farmer": [
        "smiling farmer in her 50s holding a crate of fresh vegetables in a green field at golden hour",
        "young man farmer leaning on a gate with sheep in the paddock behind him, morning light",
        "older couple of orchard owners picking apples together from a tree, smiling",
    ],
    "homeoffice": [
        "small-business owner in her 40s working happily on paperwork at the kitchen table at home, dog at her feet",
        "two women business partners laughing at a kitchen table at home with coffee mugs and notebooks",
        "young man freelancer in a cosy living room with a cup of tea, notebook on his knee, smiling",
    ],
    "laptop": [
        "close-up of hands typing on a laptop on a wooden desk beside a coffee cup and a notebook, screen facing away",
        "smiling woman shop owner using a laptop on the shop counter, laptop screen turned away from the camera",
        "man in an apron checking a laptop at a workshop bench, screen facing away, warm daylight",
    ],
}


def load_bank() -> list[dict]:
    try:
        data = json.loads(BANK_JSON.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


async def main(per_tag: int, concurrency: int, quality: str, tags: list[str]) -> None:
    images._sem = asyncio.Semaphore(concurrency)  # noqa: SLF001
    bank = load_bank()
    known = {b.get("url") for b in bank}
    lock = asyncio.Lock()

    async def register(item: dict) -> None:
        async with lock:
            if item["url"] not in known:
                bank.append(item)
                known.add(item["url"])
                tmp = BANK_JSON.with_suffix(".tmp")
                tmp.write_text(json.dumps(bank, indent=1), encoding="utf-8")
                tmp.replace(BANK_JSON)

    jobs = []
    for tag in tags:
        prompts = VARIANTS.get(tag) or [f"smiling small-business owner ({tag}) at work"]
        for n in range(1, per_tag + 1):
            name = f"{tag}_{n}.png"
            path = BANK_DIR / name
            prompt = prompts[(n - 1) % len(prompts)]
            url = f"/static/gen/bank/{name}"
            if path.exists():
                w, h = Image.open(path).size
                await register({"url": url, "tag": tag, "prompt": prompt, "w": w, "h": h})
                print(f"skip  {name} (exists)")
                continue
            jobs.append((tag, n, name, prompt, url))

    async def run(job) -> None:
        tag, n, name, prompt, url = job
        t0 = time.perf_counter()
        for attempt in range(3):
            try:
                out = await images.generate(prompt, "landscape", quality, folder=BANK_DIR, name=name)
                await register({"url": out["url"], "tag": tag, "prompt": prompt, "w": out["w"], "h": out["h"]})
                print(f"ok    {name} {out['w']}x{out['h']} in {time.perf_counter() - t0:.1f}s")
                return
            except Exception as e:  # noqa: BLE001
                print(f"retry {name} ({type(e).__name__}: {str(e)[:120]})")
                await asyncio.sleep(3 * (attempt + 1))
        print(f"FAIL  {name}")

    t0 = time.perf_counter()
    await asyncio.gather(*(run(j) for j in jobs))
    print(f"done: {len(jobs)} generated/attempted in {time.perf_counter() - t0:.1f}s; bank.json has {len(bank)} items")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-tag", type=int, default=2)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--quality", default="medium", choices=["low", "medium", "high"])
    ap.add_argument("--tags", nargs="*", default=PHOTO_TAGS)
    a = ap.parse_args()
    bad = [t for t in a.tags if t not in PHOTO_TAGS]
    if bad:
        sys.exit(f"unknown tags: {bad}; valid: {PHOTO_TAGS}")
    asyncio.run(main(a.per_tag, a.concurrency, a.quality, a.tags))
