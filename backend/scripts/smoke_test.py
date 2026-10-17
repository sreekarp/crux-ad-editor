"""API smoke test: DeepSeek pro + flash (chat latency, JSON mode, vision) and one GPT Image generation.

Usage (from backend/):  .venv/Scripts/python.exe scripts/smoke_test.py [--no-image]
Never prints keys or base URLs.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import re
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

from app.config import CHAT, GEN_DIR, keys_present, openai_client, settings  # noqa: E402


def _redact(s: str) -> str:
    s = re.sub(r"(sk-|key[=: ]+)[A-Za-z0-9_\-\*\.]{4,}", r"\1***", str(s))
    s = re.sub(r"https?://\S+", "<url>", s)
    return s.replace("\n", " ")[:140]


def _err(e: Exception) -> str:
    return f"{type(e).__name__} {getattr(e, 'status_code', '')} {_redact(str(e))}".strip()


def _red_png_data_url() -> str:
    img = Image.new("RGB", (64, 64), (230, 20, 20))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


async def chat_test(tier: str) -> dict:
    client, model, _ = CHAT[tier]
    out: dict = {"tier": tier, "model": model}
    t0 = time.perf_counter()
    try:
        r = await client.chat.completions.create(model=model, max_tokens=50, timeout=90,
                                                 messages=[{"role": "user", "content": "Reply with the single word: pong"}])
        out["chat_ms"] = int((time.perf_counter() - t0) * 1000)
        out["chat"] = "ok: " + _redact((r.choices[0].message.content or "").strip()[:40])
    except Exception as e:  # noqa: BLE001
        out["chat_ms"] = int((time.perf_counter() - t0) * 1000)
        out["chat"] = "FAIL " + _err(e)
    t0 = time.perf_counter()
    try:
        r = await client.chat.completions.create(
            model=model, max_tokens=80, timeout=90, response_format={"type": "json_object"},
            messages=[{"role": "system", "content": "You output JSON only."},
                      {"role": "user", "content": 'Return the JSON object {"ok": true, "word": "pong"}.'}])
        out["json_ms"] = int((time.perf_counter() - t0) * 1000)
        out["json_mode"] = "accepted: " + _redact((r.choices[0].message.content or "").strip()[:50])
    except Exception as e:  # noqa: BLE001
        out["json_ms"] = int((time.perf_counter() - t0) * 1000)
        out["json_mode"] = "REJECTED " + _err(e)
    t0 = time.perf_counter()
    try:
        r = await client.chat.completions.create(
            model=model, max_tokens=40, timeout=90,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": "What is the dominant colour of this image? Answer with one word."},
                {"type": "image_url", "image_url": {"url": _red_png_data_url()}}]}])
        ans = (r.choices[0].message.content or "").strip()
        out["vision_ms"] = int((time.perf_counter() - t0) * 1000)
        out["vision"] = ("WORKS" if "red" in ans.lower() else "accepted-but-blind") + f": {_redact(ans[:30])}"
    except Exception as e:  # noqa: BLE001
        out["vision_ms"] = int((time.perf_counter() - t0) * 1000)
        out["vision"] = "REJECTED " + _err(e)
    return out


async def image_test() -> dict:
    out: dict = {"model": settings.image_model}
    t0 = time.perf_counter()
    try:
        r = await openai_client.images.generate(
            model=settings.image_model, n=1, size="1024x1024", quality="low",
            prompt="Candid natural photo of a smiling florist arranging flowers in her shop, warm daylight, "
                   "shallow depth of field, authentic, editorial, no text, no logos, no watermarks, no UI screens")
        out["ms"] = int((time.perf_counter() - t0) * 1000)
        d = r.data[0]
        if getattr(d, "b64_json", None):
            raw = base64.b64decode(d.b64_json)
        else:
            import httpx
            async with httpx.AsyncClient(timeout=60) as h:
                raw = (await h.get(d.url)).content
        p = GEN_DIR / f"smoke_{uuid.uuid4().hex[:8]}.png"
        p.write_bytes(raw)
        w, h = Image.open(p).size
        out["result"] = f"ok {w}x{h} -> /static/gen/{p.name}"
    except Exception as e:  # noqa: BLE001
        out["ms"] = int((time.perf_counter() - t0) * 1000)
        out["result"] = "FAIL " + _err(e)
    return out


async def main(no_image: bool) -> None:
    print("keys present:", keys_present())
    tasks = [chat_test("pro"), chat_test("flash")]
    if not no_image:
        tasks.append(image_test())
    res = await asyncio.gather(*tasks)
    print("\n| tier | model | chat (ms) | JSON mode (ms) | vision (ms) |")
    print("|---|---|---|---|---|")
    for r in res[:2]:
        print(f"| {r['tier']} | {r['model']} | {r['chat']} ({r['chat_ms']}) | {r['json_mode']} ({r['json_ms']}) | "
              f"{r['vision']} ({r['vision_ms']}) |")
    if not no_image:
        im = res[2]
        print(f"\n| image model | result | latency (ms) |\n|---|---|---|\n| {im['model']} | {im['result']} | {im['ms']} |")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-image", action="store_true")
    asyncio.run(main(ap.parse_args().no_image))
