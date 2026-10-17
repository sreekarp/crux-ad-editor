"""Analyse an uploaded flat image: DeepSeek vision -> Slots, else a brand-snapped palette (Pillow)."""
from __future__ import annotations

import base64
import io
import logging
import time

import openai
from PIL import Image

from . import assets as A
from .images import local_path
from .llm import LLMError, chat_json
from .prompts import analyze_messages
from .schemas import normalize_slots

log = logging.getLogger("analyze")

# Total vision time across both tiers, under the browser's analyze timeouts (agent 90 s, api.ts 120 s).
ANALYZE_BUDGET = 80.0

# Smoke test (13:20): flash accepts image_url, pro rejects it ("Model only supports text input").
_vision: dict[str, bool | None] = {"flash": None, "pro": False}


def palette(img: Image.Image, n: int = 5) -> list[str]:
    """Dominant colours snapped to brand tokens, most frequent first."""
    small = img.convert("RGB").resize((96, 96))
    q = small.quantize(colors=8, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette() or []
    counts = sorted(q.getcolors() or [], reverse=True)
    out: list[str] = []
    for _count, idx in counts:
        rgb = tuple(pal[idx * 3: idx * 3 + 3])
        tok = A.nearest_token(rgb)  # type: ignore[arg-type]
        if tok not in out:
            out.append(tok)
        if len(out) >= n:
            break
    return out


def _data_url(img: Image.Image, max_side: int = 1024) -> str:
    im = img.convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def upload_data_url(url: str) -> str:
    """/static/... upload -> JPEG data URL for a vision call (raises if the file is missing)."""
    return _data_url(Image.open(local_path(url)))


def vision_supported(tier: str) -> bool:
    """False once a tier has rejected image input (cached by analyze)."""
    return _vision.get(tier) is not False


async def analyze(url: str) -> dict:
    img = Image.open(local_path(url))
    pal = palette(img)
    deadline = time.perf_counter() + ANALYZE_BUDGET
    for tier in ("flash", "pro"):
        if _vision.get(tier) is False:
            continue
        try:
            data = await chat_json(analyze_messages(_data_url(img)), tier=tier, max_tokens=2500, temperature=0.2,
                                   fallback=False, deadline=deadline)
            _vision[tier] = True
            slots = normalize_slots(data.get("slots") if isinstance(data.get("slots"), dict) else data)
            texts = [str(t).strip() for t in (data.get("texts") or []) if str(t).strip()][:30]
            return {"method": "vision", "slots": slots, "texts": texts, "palette": pal}
        except LLMError as e:
            msg = str(e).lower()
            if "image" in msg or "content type" in msg or "multimodal" in msg or "vision" in msg:
                _vision[tier] = False
                log.warning("vision unsupported on %s; caching that", tier)
            else:
                log.warning("vision call failed on %s: %s", tier, str(e)[:200])
        except (openai.APIError, ValueError) as e:
            log.warning("vision parse/call failed on %s: %s", tier, str(e)[:200])
    return {"method": "none", "palette": pal}
