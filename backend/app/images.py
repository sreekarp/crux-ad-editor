"""GPT Image: generate / edit photos, photo bank listing. Photos only - never text, logos or UI."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
import time
import uuid
from pathlib import Path

import httpx
from PIL import Image

from .config import BANK_JSON, GEN_DIR, STATIC_DIR, openai_client, settings

log = logging.getLogger("images")

SIZES = {"landscape": "1536x1024", "square": "1024x1024", "portrait": "1024x1536"}
PHOTO_STYLE = ("candid natural photo, warm daylight, real small-business owner at work, smiling, shallow depth of "
               "field, authentic, editorial, no text, no logos, no screens with UI")
NO_TEXT = "no text, no logos, no watermarks, no UI screens"

_sem = asyncio.Semaphore(4)
# The browser gives up on /api/photo and /api/pixel-edit at 240 s (frontend/src/api.ts). Stop before that, time spent
# waiting for a free slot included, so an abandoned request doesn't keep running (and billing) and holding a slot.
IMAGE_DEADLINE = 225.0


async def _image_call(make):
    async def run():
        async with _sem:
            return await make()
    try:
        return await asyncio.wait_for(run(), timeout=IMAGE_DEADLINE)
    except asyncio.TimeoutError as e:
        raise RuntimeError(f"the image API took longer than {IMAGE_DEADLINE:.0f}s") from e


def photo_prompt(subject: str) -> str:
    subject = subject.strip().rstrip(".")
    return f"{subject}. {PHOTO_STYLE}. {NO_TEXT}."


async def _to_png_bytes(item) -> bytes:
    if getattr(item, "b64_json", None):
        return base64.b64decode(item.b64_json)
    if getattr(item, "url", None):
        async with httpx.AsyncClient(timeout=60) as h:
            r = await h.get(item.url)
            r.raise_for_status()
            return r.content
    raise RuntimeError("image API returned no image data")


def _save(raw: bytes, folder: Path = GEN_DIR, name: str | None = None) -> dict:
    img = Image.open(io.BytesIO(raw))
    name = name or f"{uuid.uuid4().hex[:12]}.png"
    path = folder / name
    if img.format != "PNG":
        img.save(path, "PNG")
    else:
        path.write_bytes(raw)
    rel = path.relative_to(STATIC_DIR).as_posix()
    return {"url": f"/static/{rel}", "w": img.width, "h": img.height}


async def generate(subject: str, orientation: str = "landscape", quality: str = "medium",
                   folder: Path = GEN_DIR, name: str | None = None, styled: bool = True) -> dict:
    """Generate one photo -> {url, w, h}. `subject` is the scene; the brand photo style is appended."""
    prompt = photo_prompt(subject) if styled else f"{subject.strip().rstrip('.')}. {NO_TEXT}."
    size = SIZES.get(orientation, SIZES["landscape"])
    t0 = time.perf_counter()
    r = await _image_call(lambda: openai_client.images.generate(model=settings.image_model, prompt=prompt, size=size,
                                                               quality=quality, n=1))
    raw = await _to_png_bytes(r.data[0])
    out = _save(raw, folder, name)
    log.info("image generate %s %s q=%s ms=%d -> %s", orientation, size, quality,
             int((time.perf_counter() - t0) * 1000), out["url"])
    return out


def orientation_for(aspect: float | None, default: str = "landscape") -> str:
    """Generation orientation for a target usable w/h (shape-aware photos); `default` when no aspect is given."""
    if not aspect or aspect <= 0:
        return default
    return "portrait" if aspect < 0.8 else "landscape" if aspect > 1.25 else "square"


def image_region(region: list[float] | None, box_aspect: float | None, orientation: str) -> list[float] | None:
    """Visible region in BOX fractions -> fractions of the image generated at `orientation`. The editor cover-fits the
    image over the whole box, centred (focus 0.5) at zoom 1 (frontend canvas/photo.ts), so when the generation size is
    wider than the box its sides fall outside the box (taller: its top and bottom). None when no region is given."""
    if not region or len(region) != 4:
        return None
    x0, y0, x1, y1 = (float(v) for v in region)
    w, h = (int(v) for v in SIZES.get(orientation, SIZES["landscape"]).split("x"))
    img = w / h
    if box_aspect and box_aspect > 0:
        if img > box_aspect:  # image wider than the box: only the middle `s` of its width is in the box
            s = box_aspect / img
            x0, x1 = (1 - s) / 2 + x0 * s, (1 - s) / 2 + x1 * s
        elif img < box_aspect:  # image taller: only the middle `s` of its height is in the box
            s = img / box_aspect
            y0, y1 = (1 - s) / 2 + y0 * s, (1 - s) / 2 + y1 * s
    return [round(min(max(v, 0.0), 1.0), 3) for v in (x0, y0, x1, y1)]


def _region_words(r: list[float]) -> str:
    """Plain-words position of a region in the frame, e.g. 'lower-right part', 'upper middle part', 'central part'."""
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    h = "left" if cx < 0.4 else "right" if cx > 0.6 else ""
    v = "upper" if cy < 0.4 else "lower" if cy > 0.6 else ""
    if h and v:
        return f"{v}-{h} part"
    if v:
        return f"{v} middle part"
    return f"{h} part" if h else "central part"


def composition(fit: str | None, region: list[float] | None = None) -> str:
    """Composition clause so the photo survives being placed into a bloom / frame / full-bleed shape ('' = none).
    `region` = the visible area as IMAGE fractions [x0, y0, x1, y1] (see image_region): the subject is composed inside
    it. A region covering (nearly) the whole image adds nothing, so the plain `fit` clause is used then."""
    if region and len(region) == 4 and (region[2] - region[0] < 0.9 or region[3] - region[1] < 0.9):
        x0, y0, x1, y1 = (round(v * 100) for v in region)
        return ("natural, well-composed shot (close-ups are fine). Compose the shot so the subject's essential part "
                "(the whole head including all the hair, plus anything they hold) sits entirely inside the "
                f"{_region_words(region)} of the frame: the area from {x0}% to {x1}% of the width (from the left) "
                f"and {y0}% to {y1}% of the height (from the top), with clear headroom above the hair inside that "
                "area and nothing of the subject crossing its edges; everything outside that area is soft, "
                "uncluttered background continuing the same scene (no people or key objects there); nothing cut off")
    if fit in ("bloom", "frame"):
        # A bloom shows only a curved, low part of its box (8-32% of it), so blooms need more headroom than frames.
        room = "25%" if fit == "bloom" else "15%"
        where = "central or lower-middle part" if fit == "bloom" else "central part"
        return ("natural, well-composed shot (close-ups are fine) with the subject's essential part - the whole head "
                f"including all the hair, plus anything they hold - sitting well inside the {where} of the frame; "
                f"clear empty background headroom above the hair of at least {room} of the image height and clear "
                "margins on both sides; nothing important near the edges; nothing cut off")
    if fit == "full":
        return ("subject in the middle third of the frame with clear headroom above the hair; nothing important near "
                "the edges; nothing cut off")
    return ""


SUBJECT_PROMPT = (
    'Return JSON only: {"box": [x0, y0, x1, y1], "focus": [x, y]} - all values are fractions of the image width (x, '
    'from the left) and height (y, from the top), 0-1. "box" = the ESSENTIAL region of the main subject: what must '
    "stay visible for a crop of THIS photo to look good, judged from the shot itself. For a person, always include the "
    "whole head with ALL the hair and the face (never cut the top of the head); include their hands and any product "
    "they hold when those are part of the story. A close-up: just the head and shoulders. A working shot: the person "
    "plus what they are doing. A product or object: its full extent. Two main people: include both. Do not pad the "
    'box with background. "focus" = the centre of the main face (midway between two faces), or the centre of the '
    "object when there is no person.")


def _norm_xy(vals: list, tw: int, th: int) -> list[float]:
    """Model coords -> 0-1 fractions (it sometimes answers in thumbnail pixels or 0-1000); clamped."""
    v = [float(a) for a in vals]
    if max(v) > 1:
        xs, ys = v[0::2], v[1::2]
        if max(xs) <= tw + 1 and max(ys) <= th + 1:  # pixels of the thumbnail
            v = [a / max(tw if i % 2 == 0 else th, 1) for i, a in enumerate(v)]
        else:  # 0-1000 normalised
            v = [a / 1000 for a in v]
    return [round(min(max(a, 0.0), 1.0), 3) for a in v]


async def locate_subject(url: str, timeout: float = 8.0) -> dict:
    """Main subject of a /static photo via one Flash vision call (retried once) -> {focus: [x, y], box: [x0, y0, x1, y1]} (0-1
    fractions; keys present only when valid); {} on failure. box = what must stay visible for a crop to look good."""
    try:
        from .config import flash_client  # local import: keeps images importable without the chat client
        im = Image.open(local_path(url)).convert("RGB")
        im.thumbnail((640, 640))
        tw, th = im.size
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
        data = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
        # The Flash tier times out now and then; without a box the editor can't keep the head inside the shape, so a
        # failed call (timeout / API error) is retried once.
        for attempt in (1, 2):
            try:
                resp = await asyncio.wait_for(flash_client.chat.completions.create(
                    model=settings.flash_model, timeout=timeout, max_tokens=200, temperature=0,
                    response_format={"type": "json_object"},
                    messages=[{"role": "user", "content": [{"type": "text", "text": SUBJECT_PROMPT},
                                                           {"type": "image_url", "image_url": {"url": data}}]}]),
                    timeout=timeout)
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    raise
                log.info("subject locate attempt 1 failed for %s (%s): retrying once", url, type(e).__name__)
        text = resp.choices[0].message.content or ""
        m = re.search(r"\{.*\}", text, re.S)
        d = json.loads(m.group(0)) if m else {}
        out: dict = {}
        if isinstance(d.get("box"), list) and len(d["box"]) == 4:
            x0, y0, x1, y1 = _norm_xy(d["box"], tw, th)
            x0, x1 = sorted((x0, x1))
            y0, y1 = sorted((y0, y1))
            if x1 - x0 > 0.02 and y1 - y0 > 0.02:
                out["box"] = [x0, y0, x1, y1]
        if isinstance(d.get("focus"), list) and len(d["focus"]) == 2:
            out["focus"] = _norm_xy(d["focus"], tw, th)
        elif "box" in out:  # no face point: upper middle of the subject
            b = out["box"]
            out["focus"] = [round((b[0] + b[2]) / 2, 3), round(b[1] + (b[3] - b[1]) * 0.25, 3)]
        return out
    except Exception as e:  # noqa: BLE001
        log.info("subject locate failed for %s: %s %s", url, type(e).__name__, str(e)[:160])
        return {}


async def locate_focus(url: str, timeout: float = 8.0) -> list[float] | None:
    """Main face position [x, y] (0-1) of a /static photo (see locate_subject); None on failure."""
    return (await locate_subject(url, timeout)).get("focus")


def local_path(url: str) -> Path:
    """/static/... URL -> file path inside backend/static (no traversal)."""
    u = url.split("?", 1)[0]
    if "://" in u:
        u = "/" + u.split("://", 1)[1].split("/", 1)[1]
    if not u.startswith("/static/"):
        raise ValueError("url must be a /static/... path")
    p = (STATIC_DIR / u[len("/static/"):]).resolve()
    if STATIC_DIR.resolve() not in p.parents or not p.is_file():
        raise FileNotFoundError(url)
    return p


async def edit(url: str, instruction: str, quality: str = "medium") -> dict:
    """Pixel edit of an existing image (GPT Image edit) -> new {url, w, h}."""
    src = local_path(url)
    img = Image.open(src).convert("RGBA")
    ar = img.width / img.height
    size = SIZES["landscape"] if ar > 1.2 else SIZES["portrait"] if ar < 0.83 else SIZES["square"]
    buf = io.BytesIO()
    img.save(buf, "PNG")
    prompt = (f"{instruction.strip().rstrip('.')}. Keep everything else in the image unchanged: same people, framing, "
              f"lighting and style. {NO_TEXT}.")
    t0 = time.perf_counter()
    r = await _image_call(lambda: openai_client.images.edit(
        model=settings.image_model, image=("image.png", buf.getvalue(), "image/png"), prompt=prompt, size=size,
        quality=quality, n=1))
    raw = await _to_png_bytes(r.data[0])
    out = _save(raw)
    log.info("image edit ms=%d -> %s", int((time.perf_counter() - t0) * 1000), out["url"])
    return out


def bank() -> list[dict]:
    """PhotoBankItem[] whose files exist."""
    try:
        items = json.loads(BANK_JSON.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    out = []
    for it in items if isinstance(items, list) else []:
        try:
            if local_path(it["url"]):
                item = {"url": it["url"], "tag": it.get("tag", ""), "prompt": it.get("prompt", ""),
                        "w": int(it.get("w", 0)), "h": int(it.get("h", 0))}
                if isinstance(it.get("focus"), list) and len(it["focus"]) == 2:
                    item["focus"] = [float(it["focus"][0]), float(it["focus"][1])]  # subject position (bank_focus.py)
                if isinstance(it.get("box"), list) and len(it["box"]) == 4:
                    item["box"] = [float(v) for v in it["box"]]  # essential subject region (bank_box.py)
                out.append(item)
        except Exception:  # noqa: BLE001
            continue
    return out
