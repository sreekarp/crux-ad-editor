"""Agent Mode: /api/agent/plan (understand the request, ask only when it matters) and /api/agent/critique (review a
rendered design and propose fixes). Spec: docs/superpowers/specs/2026-10-17-agent-mode-design.md.

Both endpoints only decide; the frontend acts (existing concepts/edit endpoints, store.apply with autofix).
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from .llm import BadJSON, LLMError, chat_json
from .prompts import critique_messages, plan_messages
from .schemas import CritiqueRequest, CritiqueResponse, PlanContext, PlanRequest, PlanResponse, normalize_ops

log = logging.getLogger("agent")
router = APIRouter()

# Frontend timeouts are 28 s (plan) and 32 s (critique, review.ts): finish (or fail cleanly) before them.
_PLAN_BUDGET = 26.0
_CRITIQUE_BUDGET = 29.0


def _s(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ("" if v is None else str(v).strip())


def _clean(v: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", _s(v)).strip(' "')[:limit].strip()


def _int(v: Any, default: int) -> int:
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        m = re.search(r"\d+", _s(v))
        return int(m.group()) if m else default


async def _llm(messages: list[dict], deadline: float, cap: float, **kw: Any) -> dict:
    """chat_json under a hard wall-clock limit (chat_json's own retries could otherwise outlast the frontend)."""
    left = deadline - time.perf_counter()
    if left < 3:
        raise LLMError("time budget exhausted")
    budget = min(cap, left)
    try:
        return await asyncio.wait_for(chat_json(messages, timeout=budget, **kw), timeout=budget + 1)
    except asyncio.TimeoutError as e:
        raise LLMError(f"timed out after {budget:.0f}s") from e


# --------------------------------------------------------------------------------------------- plan

_ACTIONS = ["ask", "create", "edit", "recreate", "variations", "resize", "fix", "chat", "steps"]
_ACTION_ALIASES = {"clarify": "ask", "question": "ask", "questions": "ask", "new": "create", "generate": "create",
                   "concepts": "create", "make": "create", "variation": "variations", "like_this": "variations",
                   "multi": "steps", "multistep": "steps", "multi_step": "steps", "step": "steps", "reply": "chat",
                   "answer": "chat", "format": "resize", "brand_fix": "fix", "fix_all": "fix", "autofix": "fix"}
_STEP_ACTIONS = ("edit", "resize", "fix")
# Questions about things the system decides (brand, layout) are never asked.
_BRAND_Q = re.compile(r"\b(colou?rs?|colou?rway|fonts?|typeface|logo|palette|templates?|layout)\b", re.I)
_OTHER_OPT = re.compile(r"^(other|something else|none of these|custom)\W*$", re.I)
_LIKE_THIS = re.compile(r"\b(like (this|that|it|these|the (reference|selected|upload(ed)?|image|one))|similar|"
                        r"same (style|look|vibe)|in (this|that) style|recreate|replicate|reproduce|variations?)\b", re.I)
_RECREATE = re.compile(r"\b(recreate|replicate|reproduce|rebuild this|make (this|it) editable|exactly like this)\b", re.I)
_NEW_DESIGNS = re.compile(r"\b(new|another|more|\d+|an?|some|few|several|couple of)\s+(\w+\s+)?"
                          r"(ads?|designs?|concepts?|options?|versions?|posts?|banners?)\b", re.I)
_DEFAULT_REPLY = {"ask": "A couple of quick questions so it fits.", "create": "On it.", "variations": "On it.",
                  "recreate": "Rebuilding it as editable layers.", "edit": "On it.", "steps": "Working through it step by step.",
                  "resize": "Resizing it.", "fix": "Fixing the brand issues.", "chat": "How can I help with your ads?"}


_WHICH_BIZ = re.compile(r"\bwhich (kinds? of )?business(es)?\b", re.I)
# Look/mood words -> colourway: a requirement the review checks + a "LOOK:" brief line /concepts follows.
_LOOKS = {
    "light": (re.compile(r"\b(refreshing|fresh(?!\s+(?:headlines?|copy|angles?|takes?|ideas?|lines?|concepts?|designs?|"
                         r"options?|versions?))|bright|light(?:er)?|airy|summery|clean|calm)\b", re.I),
              "Light, fresh look: light colourway (sky or white background)", "LOOK: light colourway."),
    "dark": (re.compile(r"\b(bold(?!\s+(?:headlines?|text|fonts?|type|copy|letters?))|premium|serious|dramatic|night|"
                        r"dark(?:er)?|navy)\b", re.I),
             "Dark, bold look: navy (dark) colourway", "LOOK: dark colourway."),
    "blue": (re.compile(r"\b(energetic|vibrant|punchy)\b", re.I), "Vibrant look: blue colourway", "LOOK: blue colourway."),
}
_LOOK_REQ = re.compile(r"\b(look|colou?rway)\b", re.I)
_LOOK_TEMPLATE = {"light": {"bold": "offer", "checklist": "card"}, "dark": {"offer": "bold", "split": "bold"},
                  "blue": {"offer": "bold", "split": "bold"}}  # mirrors main._LOOK_TEMPLATE


def _look_of(text: str) -> str | None:
    """The earliest look word in the user's words wins ("bright but premium" -> light)."""
    # negated look words don't count ("nothing too dark or serious, keep it bright" -> light)
    text = re.sub(r"\b(?:not|no|nothing|without|less|too|never|avoid)\b(?:[ \t]+[\w'-]+){0,4}", " ", text or "",
                  flags=re.I)
    hits = [(m.start(), cw) for cw, (rx, _, _) in _LOOKS.items() if (m := rx.search(text))]
    return min(hits)[1] if hits else None


_EXPLICIT_COUNT = re.compile(r"\b([1-8]|two|three|four|five|six|seven|eight)\b", re.I)


def _str_list(v: Any, limit: int, n: int) -> list[str]:
    items = v if isinstance(v, list) else ([v] if isinstance(v, str) and v.strip() else [])
    out: list[str] = []
    for it in items:
        t = _clean(it, limit)
        if t and t.lower() not in {x.lower() for x in out}:
            out.append(t)
    return out[:n]


def _subjects_from_answers(answers: dict | None) -> list[str]:
    """The "Which businesses?" answer ("Bakery, Florist and Restaurant") -> ["bakery", "florist", "restaurant"]."""
    for q, a in (answers or {}).items():
        if _WHICH_BIZ.search(_s(q)) and _s(a):
            parts = re.split(r"\s*(?:,|;|/|\band\b|&|\+)\s*", _s(a))
            return [p.lower() for p in (_clean(x, 60) for x in parts) if p][:8]
    return []


def _size(v: Any) -> str | None:
    s = _s(v).lower().replace(" ", "")
    if s in ("4:5", "1:1", "9:16"):
        return s
    if not s or s in ("null", "none"):
        return None
    if "9:16" in s or "1920" in s or re.search(r"stor(y|ies)|reels?|vertical|tiktok", s):
        return "9:16"
    if "1:1" in s or "1080x1080" in s or "square" in s or "carousel" in s:
        return "1:1"
    if "4:5" in s or "1350" in s or "feed" in s or "portrait" in s:
        return "4:5"
    return None


def _slug(text: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:24].strip("_") or "q"
    out, i = base, 2
    while out in taken:
        out, i = f"{base}_{i}", i + 1
    taken.add(out)
    return out


def _questions(raw: Any) -> list[dict]:
    out: list[dict] = []
    taken: set[str] = set()
    for q in raw if isinstance(raw, list) else []:
        if not isinstance(q, dict):
            continue
        text = _clean(q.get("q") or q.get("question") or q.get("text"), 120)
        if not text or _BRAND_Q.search(text):
            continue
        opts: list[str] = []
        for o in q.get("options") or q.get("choices") or []:
            o = _clean((o.get("label") or o.get("value")) if isinstance(o, dict) else o, 40)
            if o and not _OTHER_OPT.match(o) and o.lower() not in {x.lower() for x in opts}:
                opts.append(o)
        if len(opts) < 2:
            continue
        multi = q.get("multi") is True or _s(q.get("multi")).lower() == "true" or bool(_WHICH_BIZ.search(text))
        out.append({"id": _slug(_s(q.get("id")) or text, taken), "q": text, "options": opts[:4], "multi": multi})
        if len(out) == 3:
            break
    return out


def _label(prompt: str) -> str:
    words = re.sub(r"[.;:!?]+$", "", prompt).split()[:4]
    t = " ".join(words)
    return t[:1].upper() + t[1:]


def _steps(raw: Any) -> list[dict]:
    out: list[dict] = []
    for st in raw if isinstance(raw, list) else []:
        if isinstance(st, str):
            st = {"action": "edit", "prompt": st}
        if not isinstance(st, dict):
            continue
        act = _s(st.get("action")).lower()
        prompt = _clean(st.get("prompt") or st.get("instruction") or st.get("label"), 300)
        if not prompt:
            continue
        out.append({"action": act if act in _STEP_ACTIONS else "edit", "prompt": prompt,
                    "label": _clean(st.get("label"), 40) or _label(prompt)})
        if len(out) == 5:
            break
    return out


def _act_instead_of_ask(ctx: PlanContext, msg: str) -> str:
    """The planner may not ask (already asked / nothing usable to ask / user pointed at an image): pick an action."""
    if (ctx.hasUpload or ctx.selectedRefId) and _LIKE_THIS.search(msg):
        return "recreate" if ctx.hasUpload and _RECREATE.search(msg) else "variations"
    if ctx.hasDesign and not _NEW_DESIGNS.search(msg):
        return "edit"
    return "create"


def guard_plan(data: dict, req: PlanRequest) -> dict:
    """Coerce the planner's JSON into a valid PlanResponse. Raises ValueError only when it is unusable."""
    ctx, msg = req.context, req.message.strip()
    action = _s(data.get("action")).lower().replace("-", "_").replace(" ", "_")
    action = _ACTION_ALIASES.get(action, action)
    if action not in _ACTIONS:
        raise ValueError(f'"action" must be one of {", ".join(_ACTIONS)} (got {data.get("action")!r})')
    questions, steps, size = _questions(data.get("questions")), _steps(data.get("steps")), _size(data.get("size"))
    if any(q["multi"] for q in questions):  # "Which businesses?" sets the count: never also ask "how many"
        questions = [q for q in questions if not re.search(r"\bhow many\b", q["q"], re.I)]
    prompt = _clean(data.get("prompt"), 600) or msg
    reply = _clean(data.get("reply"), 400)
    pointed = bool((ctx.hasUpload or ctx.selectedRefId) and _LIKE_THIS.search(msg))
    if action == "ask" and (ctx.askedAlready or not questions or pointed):
        action, reply = _act_instead_of_ask(ctx, msg), ""
    if action in ("edit", "steps", "resize", "fix") and not ctx.hasDesign:
        action, reply = "create", ""
    if action == "variations" and not (ctx.hasDesign or ctx.hasUpload or ctx.selectedRefId):
        action = "create"
    if action == "recreate" and not ctx.hasUpload:
        # a selected reference is "recreated" by /concepts (reference + count 1 + "recreate" in the prompt)
        action, prompt = ("variations", "Recreate the selected reference exactly.") if ctx.selectedRefId else ("create", prompt)
    if action == "steps" and len(steps) < 2:
        if len(steps) == 1 and steps[0]["action"] != "edit":
            action, prompt = steps[0]["action"], steps[0]["prompt"]
        else:
            action, prompt = "edit", " ".join(s["prompt"] for s in steps) or prompt
    if action == "resize":
        size = size or _size(prompt) or _size(msg)
        if not size:
            action = "edit"  # the edit endpoint understands free-form format requests
    count = max(1, min(8, _int(data.get("count"), 3 if action == "variations" else 1)))
    if action not in ("create", "variations"):
        count = 1
    brief = _clean(data.get("brief"), 800) or None
    if not brief and ctx.answers:
        brief = " ".join(f"{_clean(q, 80).rstrip('?')}: {_clean(a, 80)}." for q, a in ctx.answers.items() if _s(a)) or None
    # spec §9: subjects (one per design), theme, requirements
    theme = _clean(data.get("theme"), 40) or None
    if theme and theme.lower() in ("null", "none", "no", "n/a"):
        theme = None
    subjects: list[str] = []
    requirements: list[str] = []
    if action in ("create", "variations"):
        subjects = _str_list(data.get("subjects"), 60, 8) or _subjects_from_answers(ctx.answers)
        requirements = _str_list(data.get("requirements"), 120, 6)
        if subjects:
            answered_count = any(re.search(r"how many", _s(q), re.I) and _EXPLICIT_COUNT.search(_s(a))
                                 for q, a in (ctx.answers or {}).items())
            if _EXPLICIT_COUNT.search(msg) or answered_count:
                subjects = subjects[:count]
            else:
                count = max(1, min(8, len(subjects)))
                subjects = subjects[:count]
        look = _look_of(" ".join([msg] + [_s(a) for a in (ctx.answers or {}).values()]))
        if look:  # code owns the look: one canonical requirement + brief line (the model's own look lines replaced)
            _, look_req, look_line = _LOOKS[look]
            requirements = ([look_req] + [r for r in requirements if not _LOOK_REQ.search(r)])[:6]
            brief = (re.sub(r"\s*LOOK:[^.]*\.?", "", brief or "").strip() + " " + look_line).strip()
    out = {
        "understanding": _clean(data.get("understanding"), 160) or msg[:120] or "Your request",
        "action": action,
        "questions": questions if action == "ask" else [],
        "prompt": prompt,
        "brief": brief,
        "count": count,
        "size": size if action in ("create", "variations", "resize", "recreate") else None,
        "steps": steps if action == "steps" else [],
        "reply": reply or _DEFAULT_REPLY[action],
        "subjects": subjects,
        "theme": theme if action in ("ask", "create", "variations") else None,
        "requirements": requirements,
    }
    return PlanResponse.model_validate(out).model_dump()


@router.post("/api/agent/plan")
async def plan(req: PlanRequest) -> dict:
    t0 = time.perf_counter()
    deadline = t0 + _PLAN_BUDGET
    messages = plan_messages(req.message, [h.model_dump() for h in req.history], req.context.model_dump())
    out: dict = {}
    for attempt in range(2):
        try:
            # 11 s first try leaves room for one retry inside the budget when Flash is slow / overloaded
            data = await _llm(messages, deadline, 11 if attempt == 0 else 13, tier="flash", max_tokens=1200,
                              temperature=0.3)
            out = guard_plan(data, req)
            break
        except (BadJSON, ValueError) as e:
            log.warning("plan attempt %d invalid: %s", attempt + 1, e)
            if attempt == 1 or deadline - time.perf_counter() < 5:
                raise HTTPException(502, f"Model returned an invalid plan: {e}")
            messages = messages + [{"role": "user", "content": f"Your previous output was invalid ({e}). Return only "
                                    "the JSON object described in OUTPUT."}]
        except LLMError as e:
            if attempt == 0 and deadline - time.perf_counter() > 8:
                log.warning("plan attempt 1 failed (%s): retrying once", str(e)[:200])
                continue
            raise HTTPException(503, f"LLM unavailable: {e}")
    log.info("plan action=%s count=%s asked=%s ms=%d", out["action"], out["count"], req.context.askedAlready,
             int((time.perf_counter() - t0) * 1000))
    return out


# --------------------------------------------------------------------------------------------- critique

_CRITIQUE_OPS = {"update", "rebuild", "delete", "reorder", "reframe"}  # the review never generates images
_DECOR = {"bloom", "bg-shape", "bgshape"}  # decorations that must sit BEHIND the copy
_COPY_ROLES = {"headline", "headline2", "sub", "cta", "logo", "disclaimer"}
_CROP_WORD = re.compile(r"\bcrop\w*|\bframing\b|\bout of (the )?frame\b", re.I)
_CUT_WORD = re.compile(r"\b(cut\w*|hid(e|es|den|ing)|obscur\w*|chopped|missing)\b", re.I)
_PERSON = re.compile(r"\b(face|faces|head|heads|person|owner|maker|subject|portrait|woman|man|people)\b", re.I)
_PHOTO_WORD = re.compile(r"\b(photo|picture|image|face|head|person|owner|maker|subject|portrait)\b", re.I)


def _crop_complaint(text: str) -> bool:
    """"photo crop hides the maker's face", "her head is cut off" -> True; "headline is cut off" -> False."""
    return bool((_CROP_WORD.search(text) and _PHOTO_WORD.search(text)) or (_CUT_WORD.search(text) and _PERSON.search(text)))


def _look_colourway(requirements: list[str] | None) -> str | None:
    for r in requirements or []:
        m = re.search(r"\blook\b.*?\b(light|dark|navy|blue)\b", r, re.I)
        if m:
            return "dark" if m.group(1).lower() == "navy" else m.group(1).lower()
    return None


def _decor_over_copy(design: dict, ops: list[dict]) -> tuple[list[dict], list[str]]:
    """A bloom/bg-shape drawn ABOVE (later in layers) a copy/logo layer it overlaps -> send it behind the copy.

    "back" when nothing else it overlaps sits below it (identical result, the op the spec names); otherwise step it
    "backward" just under the lowest copy layer it covers so it stays over the photo (max 3 steps, else "back")."""
    layers = [l for l in design.get("layers") or [] if isinstance(l, dict) and l.get("id")]
    idx = {str(l["id"]): i for i, l in enumerate(layers)}
    boxes = {lid: (role, (x, y, w, h)) for lid, role, x, y, w, h in _boxes(design)}
    kinds = {str(l["id"]): str(l.get("kind") or "") for l in layers}
    taken = {o.get("id") for o in ops if o.get("id") and o.get("op") != "update"}
    moved = {o["id"]: o.get("props") or {} for o in ops if o.get("op") == "update" and o.get("id")}
    new_ops: list[dict] = []
    notes: list[str] = []
    for lid, (role, box) in boxes.items():
        if not (role in _DECOR or kinds.get(lid) in _DECOR) or lid in taken:
            continue
        if lid in moved:  # the critic already moves it: judge where it lands
            p = moved[lid]
            if p.get("hidden"):
                continue
            try:
                box = tuple(float(p.get(k, v)) for k, v in zip(("x", "y", "width", "height"), box))  # type: ignore
            except (TypeError, ValueError):
                continue
        under = [(idx[o], orole) for o, (orole, obox) in boxes.items()
                 if o != lid and idx.get(o, 1 << 30) < idx[lid] and _hits(box, obox)
                 and (orole in _COPY_ROLES or kinds.get(o) == "button")]
        if not under:
            continue
        low, low_role = min(under)
        # land just under the lowest covered copy, or under the card/row panel that copy sits on -- never under the
        # photo/device (no "back": index 0 buries it beneath the photo and card)
        floor = max([idx[o] for o, (orole, obox) in boxes.items() if orole in ("photo", "device")
                     and idx.get(o, 1 << 30) < idx[lid] and _hits(box, obox)], default=-1)
        panels = [idx[o] for o, (orole, obox) in boxes.items() if o != lid and orole in ("card", "row")
                  and floor < idx.get(o, -1) < low and _hits(box, obox)]
        target = min(panels) if panels else low
        new_ops += [{"op": "reorder", "id": lid, "to": "backward"}] * (idx[lid] - target)
        name = "bloom" if (role in ("bloom",) or kinds.get(lid) == "bloom") else "background shape"
        what = {"cta": "CTA", "headline2": "headline", "logo": "logo"}.get(low_role, low_role or "copy")
        notes.append(f"Moved the {name} behind the {what}")
    return new_ops, notes
_PROTECTED = {"headline", "cta", "logo"}  # never deleted by the review
_TEXTISH = {"headline", "headline2", "sub", "cta", "disclaimer", "row-text"}
_GUARDED = _TEXTISH | {"logo"}
_CLUTTER = {"charm", "stat", "tags", "decor"}
_vision_ok: bool | None = None  # learned: does the flash endpoint accept image_url?


def _boxes(design: dict) -> list[tuple[str, str, float, float, float, float]]:
    out = []
    for l in design.get("layers") or []:
        if not isinstance(l, dict) or l.get("hidden") or not l.get("id"):
            continue
        box = l.get("box")
        if not isinstance(box, (list, tuple)) and all(k in l for k in ("x", "y", "width", "height")):
            box = [l[k] for k in ("x", "y", "width", "height")]
        try:
            x, y, w, h = (float(v) for v in box)  # type: ignore[union-attr]
        except (TypeError, ValueError):
            continue
        out.append((str(l["id"]), str(l.get("role") or l.get("kind") or ""), x, y, w, h))
    return out


def geometry_notes(design: dict) -> list[str]:
    """Box overlaps between copy/logo and clutter, and copy hugging the canvas edge: hard facts for the critic."""
    W, H = float(design.get("width") or 1080), float(design.get("height") or 1350)
    items = _boxes(design)
    notes: list[str] = []
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            ra, rb = a[1], b[1]
            if not ((ra in _GUARDED and (rb in _GUARDED or rb in _CLUTTER)) or (rb in _GUARDED and ra in _CLUTTER)):
                continue
            ix = min(a[2] + a[4], b[2] + b[4]) - max(a[2], b[2])
            iy = min(a[3] + a[5], b[3] + b[5]) - max(a[3], b[3])
            small = min(a[4] * a[5], b[4] * b[5]) or 1.0
            if ix > 0 and iy > 0 and ix * iy / small >= 0.03:
                notes.append(f"{a[0]} ({ra}) overlaps {b[0]} ({rb}): {round(100 * ix * iy / small)}% of the smaller box")
    m = 0.03 * W
    for lid, role, x, y, w, h in items:
        if role in _TEXTISH and (x < m or y < m or x + w > W - m or y + h > H - m):
            notes.append(f"{lid} ({role}) is within 3% of the canvas edge or outside it")
    return notes[:10]


def _hits(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    ix = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    iy = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return ix > 0 and iy > 0 and ix * iy / (min(a[2] * a[3], b[2] * b[3]) or 1.0) >= 0.03


def _settle_moves(ops: list[dict], design: dict) -> None:
    """A charm/stat the critic moves must land clear of the copy and logo (the model's arithmetic is rough).

    Picks the nearest position to the model's target that is on canvas and clears every copy/logo box (and, if
    possible, the other charms/stat). Leaves the op alone when nothing clears: the review re-measures anyway.
    """
    W, H = float(design.get("width") or 1080), float(design.get("height") or 1350)
    items = {lid: (role, (x, y, w, h)) for lid, role, x, y, w, h in _boxes(design)}
    pad, mx, my = 0.015 * W, 0.02 * W, 0.02 * H
    for op in ops:
        if op["op"] != "update" or op["id"] not in items or items[op["id"]][0] not in _CLUTTER:
            continue
        p, (_, old) = op["props"], items[op["id"]]
        if not ({"x", "y", "width", "height"} & set(p)):
            continue
        w, h = float(p.get("width", old[2])), float(p.get("height", old[3]))
        tx, ty = float(p.get("x", old[0])), float(p.get("y", old[1]))
        guarded = [b for lid, (r, b) in items.items() if r in _GUARDED and lid != op["id"]]
        clutter = [b for lid, (r, b) in items.items() if r in _CLUTTER and lid != op["id"]]
        if not any(_hits((tx, ty, w, h), g) for g in guarded):
            continue
        xs = {tx, mx, W - mx - w} | {g[0] + g[2] + pad for g in guarded} | {g[0] - w - pad for g in guarded}
        ys = {ty, my, H - my - h} | {g[1] + g[3] + pad for g in guarded} | {g[1] - h - pad for g in guarded}
        cands = [(x, y) for x in xs for y in ys if mx <= x and x + w <= W - mx and my <= y and y + h <= H - my]
        cands.sort(key=lambda c: (c[0] - tx) ** 2 + (c[1] - ty) ** 2)
        for avoid in (guarded + clutter, guarded):
            best = next((c for c in cands if not any(_hits((c[0], c[1], w, h), b) for b in avoid)), None)
            if best:
                p["x"], p["y"] = round(best[0]), round(best[1])
                break


def _is_image(v: str | None) -> bool:
    return bool(v) and v.startswith("data:image/") and len(v) < 12_000_000  # type: ignore[union-attr]


def guard_critique(data: dict, design: dict, slots: dict | None, used_vision: bool,
                   requirements: list[str] | None = None) -> dict:
    """Coerce the critic's JSON into a valid CritiqueResponse. Raises ValueError only when it is unusable."""
    raw_score = data.get("visionScore", data.get("score"))
    if raw_score is None:
        raise ValueError('"visionScore" (0-100) is missing')
    score = _int(raw_score, -1)
    if score < 0:
        raise ValueError('"visionScore" must be a number 0-100')
    score = min(100, score)
    roles = {lid: role for lid, role, *_ in _boxes(design)}
    # spec §9: requirements this design misses; any miss -> fix, score <= 70; one photo op on a real photo layer
    misses = _str_list(data.get("briefMisses"), 160, 5) if requirements else []
    photo_ids = {str(l.get("id")) for l in design.get("layers") or []
                 if isinstance(l, dict) and l.get("kind") == "photo" and l.get("id")}
    photo_used = False
    look_cw = _look_colourway(requirements)
    cur_cw = _s((slots or {}).get("colourway") or design.get("colourway")).lower()
    raw_ops = []
    for op in data.get("ops") or []:
        if isinstance(op, dict) and _s(op.get("op")).lower() == "photo":
            if misses and not photo_used and str(op.get("id")) in photo_ids and _clean(op.get("prompt"), 300):
                photo_used = True
                raw_ops.append({"op": "photo", "id": str(op.get("id")), "prompt": _clean(op.get("prompt"), 300)})
            continue
        if not isinstance(op, dict) or _s(op.get("op")).lower() not in _CRITIQUE_OPS:
            continue
        op = dict(op)
        if _s(op.get("op")).lower() == "reorder" and roles.get(str(op.get("id"))) in _DECOR:
            continue  # code places decorations (_decor_over_copy); a model "back" buries them under the photo
        if _s(op.get("op")).lower() == "reframe" and str(op.get("id")) not in photo_ids:
            continue  # reframe only an existing photo layer
        if _s(op.get("op")).lower() == "rebuild" and isinstance(op.get("slots"), dict):
            # rebuild keeps the existing photo and layout family: no hero/template/mask changes from the review,
            # except a LOOK miss: the required colourway may switch to a template that allows it
            look_fix = bool(look_cw) and _s(op["slots"].get("colourway")).lower() == look_cw \
                and _s(op["slots"].get("template")).lower() in ("", "card", "offer", "bold")  # keep the photo hero
            op["slots"] = {k: v for k, v in op["slots"].items()
                           if k not in ("hero", "bloom") and (k != "template" or look_fix)}
        if _s(op.get("op")).lower() == "delete" and roles.get(op.get("id")) in _PROTECTED:
            continue
        raw_ops.append(op)
    look_miss = bool(look_cw and cur_cw and cur_cw != look_cw)
    if look_miss and not any(o.get("op") == "rebuild" and _s((o.get("slots") or {}).get("colourway")).lower() == look_cw
                             for o in raw_ops if isinstance(o.get("slots"), dict)):
        cur_t = _s((slots or {}).get("template") or design.get("template")).lower()
        look_t = _LOOK_TEMPLATE.get(look_cw, {}).get(cur_t)  # same map as main._apply_look
        raw_ops.insert(0, {"op": "rebuild", "slots": {"colourway": look_cw, **({"template": look_t} if look_t else {})}})
    if look_miss:
        look_req = next((r for r in requirements or [] if _look_colourway([r]) == look_cw), "")
        if look_req and look_req not in misses:
            misses = (misses + [look_req])[:5]
    issues_text = [_s(t) for t in ((data.get("issues") if isinstance(data.get("issues"), list) else [data.get("issues")])
                                   + [data.get("summary")]) if isinstance(t, str)]
    if photo_ids and any(_crop_complaint(t) for t in issues_text) \
            and not any(_s(o.get("op")).lower() == "reframe" for o in raw_ops):
        raw_ops.insert(0, {"op": "reframe", "id": sorted(photo_ids)[0]})  # the critic named a crop problem
    reframed = {str(o.get("id")) for o in raw_ops if _s(o.get("op")).lower() == "reframe"}
    _CROP_KEYS = {"focusX", "focusY", "zoom", "x", "y", "width", "height"}
    raw_ops = [o for o in raw_ops if not (_s(o.get("op")).lower() == "update" and str(o.get("id")) in reframed
                                          and set(o.get("props") or {}) <= _CROP_KEYS)]
    ops = []
    for op in normalize_ops(raw_ops, design, slots):
        if op["op"] == "photo" and photo_used and op.get("id") in photo_ids:
            ops.insert(0, op)  # the photo is the brief miss: fix it first
            continue
        if op["op"] not in _CRITIQUE_OPS:
            continue
        if op["op"] == "rebuild" and look_miss and op["slots"].get("colourway") not in (None, look_cw):
            continue  # the normaliser moved the look rebuild away from the required colourway: a no-op/backwards fix
        if op["op"] == "rebuild" and ({"hero", "template"} & set(op["slots"])) \
                and not (look_cw and op["slots"].get("colourway") == look_cw):
            continue  # a colourway the template can't take would switch template: not a review-sized fix (unless
            # it is the LOOK the user asked for)
        if op["op"] == "update":
            op["props"].pop("prompt", None)
            if roles.get(op["id"]) in _PROTECTED:  # hiding / fading the headline, CTA or logo = deleting it
                if op["props"].get("hidden"):
                    op["props"].pop("hidden")
                if isinstance(op["props"].get("opacity"), (int, float)) and op["props"]["opacity"] < 0.35:
                    op["props"].pop("opacity")
            if not op["props"]:
                continue
        ops.append(op)
    ops = ops[:4]
    _settle_moves(ops, design)
    verdict = "fix" if _s(data.get("verdict")).lower() == "fix" else "pass"
    if ops and verdict == "pass" and score < 85:
        verdict = "fix"
    if misses:
        verdict, score = "fix", min(score, 70)
    elif not ops or verdict == "pass":
        verdict, ops = "pass", []
    # deterministic: a bloom/bg-shape layered over copy goes behind it (first, so a later rebuild can't strand the id)
    decor_ops, decor_notes = _decor_over_copy(design, ops)
    if decor_ops:
        ops = decor_ops + ops
        verdict, score = "fix", min(score, 75)
    def _list(v: Any) -> list:  # a bare string must not be iterated character by character
        return v if isinstance(v, list) else ([v] if isinstance(v, str) else [])

    issues = [t for t in (_clean(i, 160) for i in _list(data.get("issues"))) if t][:5]
    issues = (decor_notes + issues)[:5]
    sugg: list[str] = []
    for t in (_clean(s, 70).rstrip(".") for s in _list(data.get("suggestions"))):
        if t and t.lower() not in {x.lower() for x in sugg}:
            sugg.append(t)
    out = {"visionScore": score, "verdict": verdict, "issues": issues, "ops": ops, "briefMisses": misses,
           "suggestions": sugg[:3],
           "summary": _clean(data.get("summary"), 200) or (issues[0] if issues else "Looks good."),
           "usedVision": used_vision}
    return CritiqueResponse.model_validate(out).model_dump()


@router.post("/api/agent/critique")
async def critique(req: CritiqueRequest) -> dict:
    global _vision_ok
    t0 = time.perf_counter()
    deadline = t0 + _CRITIQUE_BUDGET
    design = req.design or {}
    slots = req.slots or ({k: design[k] for k in ("template", "colourway") if design.get(k)} or None)
    brand = [t for t in (_clean((i.get("message") or i.get("msg")) if isinstance(i, dict) else i, 200)
                         for i in req.brandIssues) if t][:12]
    geometry = geometry_notes(design)
    requirements = _str_list(req.requirements or [], 160, 8)
    image = req.image if _is_image(req.image) else None
    modes = (["vision"] if image and _vision_ok is not False else []) + ["text"]
    err: str | None = None
    retried = False
    out: dict | None = None
    i = 0
    while i < len(modes):
        mode = modes[i]
        i += 1
        messages = critique_messages(design, slots, req.brief, brand, geometry, req.round,
                                     image if mode == "vision" else None, requirements=requirements)
        if err:
            messages.append({"role": "user", "content": f"Your previous output was invalid ({err}). Return only the "
                             "JSON object described in OUTPUT."})
        try:
            # vision 16 s, then the text fallback still fits the budget (the client no longer retries on its own)
            data = await _llm(messages, deadline, 16 if mode == "vision" else 14, tier="flash", max_tokens=1500,
                              temperature=0.1, fallback=mode == "text")  # pro is text-only: no fallback with an image
            if mode == "vision":
                _vision_ok = True
            out = guard_critique(data, design, slots, used_vision=mode == "vision", requirements=requirements)
            break
        except (BadJSON, ValueError) as e:
            log.warning("critique (%s) invalid: %s", mode, e)
            err = str(e)[:200]
            if mode == "vision" and not retried and deadline - time.perf_counter() > 20:
                retried = True
                modes.insert(i, "vision")
        except LLMError as e:
            msg = str(e).lower()
            log.warning("critique (%s) failed: %s", mode, str(e)[:200])
            err = None
            if mode == "vision" and any(k in msg for k in ("image", "content type", "multimodal", "vision")):
                _vision_ok = False
            if mode == "text":
                raise HTTPException(503, f"LLM unavailable: {e}")
    if out is None:
        raise HTTPException(502, f"Model returned an invalid critique: {err}")
    log.info("critique round=%d vision=%s score=%d verdict=%s ops=%d ms=%d", req.round, out["usedVision"],
             out["visionScore"], out["verdict"], len(out["ops"]), int((time.perf_counter() - t0) * 1000))
    return out
