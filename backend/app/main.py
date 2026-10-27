"""FastAPI app: copilot (concepts = Slots, edits = Ops), GPT Image photos, photo bank, uploads, analysis."""
from __future__ import annotations

import io
import json
import logging
import random
import re
import time
import uuid

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import agent
from . import assets as A
from . import images
from .analyze import analyze as analyze_image, upload_data_url, vision_supported
from .config import STATIC_DIR, UPLOADS_DIR, keys_present, settings
from .llm import BadJSON, LLMError, chat_json
from .prompts import concepts_messages, edit_messages
from .refs import get_reference, load_references, references_api
from .schemas import (ConceptsRequest, EditRequest, PhotoRequest, PixelEditRequest, UrlRequest, fix_bloom,
                      fix_photo_tag, normalize_ops, normalize_slots, PHOTO_SUBJECTS, TEMPLATE_COLOURWAYS)

log = logging.getLogger("api")

app = FastAPI(title="Xero Agentic Image Editor API")

# Total LLM time per request, kept under the browser's timeouts (frontend/src/api.ts: concepts 180 s, edit 120 s) so
# retries/fallbacks finish -- or fail with a readable message -- while the user is still waiting for the answer.
CONCEPTS_BUDGET = 165.0
IMAGE_CONCEPTS_BUDGET = 60.0  # flash + reference image; the rest of CONCEPTS_BUDGET stays for the text-only pro path
EDIT_BUDGET = 105.0

_missing_keys = [k for k, ok in keys_present().items() if not ok]
if _missing_keys:
    log.warning("API keys missing: %s -- those AI features will fail until set in .env at the project root",
                ", ".join(_missing_keys))
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(agent.router)  # Agent Mode: /api/agent/plan + /api/agent/critique


@app.get("/api/health")
async def health() -> dict:
    keys = keys_present()
    # ok = the server is up; `missing` lets the UI warn that some AI features can't work yet.
    return {"ok": True, "models": {"pro": settings.pro_model, "flash": settings.flash_model,
                                   "image": settings.image_model}, "keys": keys,
            "missing": [k for k, present in keys.items() if not present]}


@app.get("/api/references")
async def references() -> list[dict]:
    return references_api()


@app.get("/api/photos")
async def photos() -> list[dict]:
    return images.bank()


# --------------------------------------------------------------------------------------------- concepts

_RECREATE = re.compile(r"\b(recreate|replicate|reproduce|rebuild this|same as this|exactly like this)\b", re.I)


_LOOK_LINE = re.compile(r"\bLOOK:\s*(light|dark|blue)\b", re.I)
_LOOK_TEMPLATE = {"light": {"bold": "offer", "checklist": "card"}, "dark": {"offer": "bold", "split": "bold"},
                  "blue": {"offer": "bold", "split": "bold"}}


def _apply_look(concepts: list[dict], brief: str | None) -> None:
    """Agent Mode's brief line "LOOK: <colourway>" (from the user's mood words): every concept wears that colourway,
    switching to the sibling template that allows it. Runs after _diversify (which may vary the colourway)."""
    m = _LOOK_LINE.search(brief or "")
    if not m:
        return
    cw = m.group(1).lower()
    for i, c in enumerate(concepts):
        if c.get("colourway") == cw:
            continue
        t = c["template"] if cw in TEMPLATE_COLOURWAYS[c["template"]] else _LOOK_TEMPLATE[cw].get(c["template"], "card")
        concepts[i] = normalize_slots({**c, "template": t, "colourway": cw})


def _diversify(concepts: list[dict], ref: dict | None) -> list[dict]:
    """Code-enforced diversity: distinct photos, (template, colourway) pairs and photo masks across the set.

    A repeated photoTag is fine when the prompts describe different people (on-message for a niche brief); each
    photo concept gets a different bank photo when the bank has one, so the set renders instantly and distinctly.
    """
    used_pairs: set[tuple[str, str]] = set()
    used_blooms: set[str] = set()
    used_prompts: set[str] = set()
    used_urls: set[str] = set()
    bank = images.bank()
    random.shuffle(bank)
    for c in concepts:
        hero = c["hero"]
        if hero.get("type") == "photo":
            if _norm(hero.get("photoPrompt")) in used_prompts:  # literally the same shot: pick another subject
                taken = {x["hero"].get("photoTag") for x in concepts if x is not c}
                free = [t for t in A.PHOTO_TAGS if t not in taken and t != "laptop"]
                if free:
                    hero["photoTag"], hero["photoPrompt"] = free[0], PHOTO_SUBJECTS[free[0]]
            used_prompts.add(_norm(hero.get("photoPrompt")))
            if not hero.get("photoUrl"):
                pick = next((b for b in bank if b["tag"] == hero.get("photoTag") and b["url"] not in used_urls), None)
                if pick:
                    hero["photoUrl"] = pick["url"]
            if hero.get("photoUrl"):
                used_urls.add(hero["photoUrl"])
        pair = (c["template"], c["colourway"])
        if pair in used_pairs and len(concepts) > 1:
            for cw in TEMPLATE_COLOURWAYS[c["template"]]:
                if (c["template"], cw) not in used_pairs:
                    c["colourway"] = cw
                    if c["ctaStyle"] == "navy" and cw != "light" and c["template"] != "card":
                        c["ctaStyle"] = "sky"
                    break
        used_pairs.add((c["template"], c["colourway"]))
        if hero.get("type") in ("photo", "device"):
            if c["bloom"] in used_blooms:
                free_b = [b for b in A.PHOTO_MASKS if b not in used_blooms]
                if free_b:
                    c["bloom"] = free_b[0]
            used_blooms.add(c["bloom"])
    return concepts


_VOICE_LINES = ["Cash flow without the suspense.", "Data in. Doubt out.", "Run your business, not your books.",
                "Paid. No invoice chasing needed.", "Xero gets your Sundays back.", "Remember why you started? We do.",
                "Clear setup, so you can clear your schedule.", "Suddenly you're fluent in finance."]


def _norm(t: str | None) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (t or "").lower()).strip()


# Statistics, speed/time claims, prices and promotions: allowed only if the user/brief/reference supplied them.
_CLAIM_RE = re.compile(
    r"\d+(?:\.\d+)?\s?%|\bsurvey\b|\bper ?cent\b|\b\d+(?:\.\d+)?\s?x\b|\b\d+\s?(?:hours?|hrs|minutes?|mins|days?|weeks?)\b"
    r"|(?:£|\$|€|\bR)\s?\d[\d,.]*|\b(?:first|\d+)\s+months?\s+(?:free|half[- ]price)\b|\bvouchers?\b|\bdeal\b"
    r"|\bdiscount(?:ed)?\b|\bcashback\b|\bpromo(?:tion)?\b|\bhalf[- ]price\b"
    r"|\b\d+(?:[.,]\d+)?\s?(?:million|thousand|billion|k|m|bn)\b|\b\d+(?:\.\d+)?\s?stars?\b"
    r"|\b(?:most[- ]loved|best[- ]rated|top[- ]rated|number one|no\.? ?1|#1|award[- ]winning|market[- ]leading)\b"
    r"|\b\d[\d,.]*\+?\s+(?:small\s+)?(?:businesses|customers|users|subscribers|people|accountants|bookkeepers)\b",
    re.I)


def _trim_sub(sub: str | None, max_words: int = 14) -> str | None:
    """Deterministic last resort when the model's sub stays too long: first sentence, else a hard word cap."""
    if not sub or len(sub.split()) <= max_words:
        return sub
    first = re.split(r"(?<=[.!?])\s+", sub.strip())[0]
    if 3 <= len(first.split()) <= max_words:
        return first
    words = sub.split()[:max_words]
    while words and words[-1].lower().strip(",;:") in {"and", "or", "but", "so", "to", "the", "a", "with", "for", "of"}:
        words.pop()
    return " ".join(words).rstrip(",;:-") + "."
_OFFERISH = re.compile(r"%|£|\$|€|\bR\d|\bfree\b|\boff\b|voucher|\*", re.I)
# Layout mixes for blank-canvas sets so repeated prompts don't always get the same four layouts in the same order.
_MIXES = [["card", "bold", "offer", "card"], ["bold", "card", "split", "offer"], ["card", "offer", "bold", "checklist"],
          ["bold", "bold", "card", "offer"], ["split", "card", "bold", "offer"], ["card", "card", "bold", "checklist"]]


def _fix_footnotes(concepts: list[dict], ref: dict | None = None) -> None:
    """A reference's survey footnote only backs the reference's own starred claim — never a new one."""
    ref_lines = {_norm((ref or {}).get(k)) for k in ("headline", "sub")} - {""}
    for c in concepts:
        for k in ("headline", "sub"):
            t = c.get(k)
            if t and "*" in t and _norm(t) not in ref_lines:
                c[k] = re.sub(r"\s*\*+", "", t).strip()
        d = str(c.get("disclaimer") or "")
        copy = " ".join(str(c.get(k) or "") for k in ("headline", "sub", "cta"))
        if re.search(r"survey|\bsource\b", d, re.I) and "*" not in copy:
            c["disclaimer"] = "Terms apply." if _OFFERISH.search(copy) else None


def _keep_reference_structure(concepts: list[dict], ref: dict | None) -> list[dict]:
    """"Like this": at least 2 concepts keep the reference's template (+ its stat/tags/device), enforced in code."""
    if not ref or len(concepts) < 2 or ref.get("template") not in ("card", "bold", "offer"):
        return concepts
    tpl, ref_hero = ref["template"], ref.get("hero") or {}
    need = 2 - sum(1 for c in concepts if c.get("template") == tpl)
    out = []
    for c in concepts:
        if need > 0 and c.get("template") != tpl:
            c = {**c, "template": tpl, "colourway": ref.get("colourway", c.get("colourway"))}
            if ref_hero.get("type") == "device" and ref_hero.get("deviceId"):
                c["hero"] = {"type": "device", "deviceId": ref_hero["deviceId"]}
            elif ref_hero.get("type") == "none":
                c["hero"] = {"type": "none"}
            for k in ("stat", "tags"):
                if ref.get(k) and not c.get(k):
                    c[k] = ref[k]
            c = normalize_slots(c)
            need -= 1
        out.append(c)
    return out


def _copy_problems(concepts: list[dict], ref: dict | None, given: str = "") -> list[str]:
    """Copied/repeated lines, invented statistics and over-long copy (a judge or the brand checker would spot it).

    `given` = the user's prompt + brief + reference: numbers/claims that appear there are allowed.
    """
    taken = {_norm(s.get(k)) for s in [r.get("slots") or {} for r in load_references()] for k in ("headline", "headline2")} | \
            {_norm(v) for v in _VOICE_LINES}
    taken.discard("")

    def near_copy(line: str) -> str | None:  # >= 60% word overlap with an existing Xero ad line
        w = set(line.split())
        for t in taken:
            tw = set(t.split())
            if w and tw and len(w & tw) / len(w | tw) >= 0.6:
                return t
        return None
    ref_sub = _norm((ref or {}).get("sub"))
    probs, seen_h, seen_s = [], set(), set()
    for i, c in enumerate(concepts, 1):
        h, s = _norm(c.get("headline")), _norm(c.get("sub"))
        if "*" in (c.get("headline") or "") + (c.get("sub") or "") and h != _norm((ref or {}).get("headline")):
            probs.append(f'concept {i} makes a new starred claim; only the reference\'s exact claim may carry its '
                         f'footnote — write a benefit line without statistics, ratings or superlatives')
        if near_copy(h):
            probs.append(f'concept {i} headline "{c["headline"]}" copies an existing Xero ad ("{near_copy(h)}")')
        elif c.get("headline2") and near_copy(_norm(c["headline2"])):
            probs.append(f'concept {i} headline2 "{c["headline2"]}" copies an existing Xero ad; write a new one')
        elif h in seen_h:
            probs.append(f'concept {i} headline repeats another concept')
        if s and (s == ref_sub or s in seen_s):
            probs.append(f'concept {i} sub "{c["sub"]}" is copied')
        for field in ("headline", "sub", "cta", "disclaimer"):
            for m in _CLAIM_RE.findall(c.get(field) or ""):
                if _norm(m) not in _norm(given) and m.replace(" ", "") not in given.replace(" ", ""):
                    probs.append(f'concept {i} {field} invents a statistic or survey ("{m}"); remove it')
                    break
        n_h, n_s, n_c = len(c["headline"].split()), len((c.get("sub") or "").split()), len(c["cta"].split())
        if n_h > 10:
            probs.append(f"concept {i} headline has {n_h} words (max 10)")
        if n_s > 14:
            probs.append(f"concept {i} sub has {n_s} words (max 14)")
        if n_c > 5:
            probs.append(f"concept {i} cta has {n_c} words (max 5)")
        seen_h.add(h)
        if s:
            seen_s.add(s)
    return probs


_REMOVE_ASK = re.compile(r"\b(remove|delete|drop|without|hide|get rid|no (?:sub|subline|subtitle|disclaimer|stat)|"
                         r"less text|fewer words|shorter|simplify|declutter)\b", re.I)
_CROP_ASK = re.compile(r"\b(cut ?off|half ?cut|cropp?ed|crop|can'?t see|face|framing|reframe|recent(?:re|er)|"
                       r"zoom(?:ed)? (?:in|out))\b", re.I)
_PHOTO_WORDS = re.compile(r"\b(photo|image|picture|pic|her|him|his|person|lady|man|woman|face|people|owner)\b", re.I)
_STOP = {"a", "an", "the", "and", "or", "but", "to", "of", "for", "in", "on", "at", "with", "your", "you", "it", "is",
         "be", "so", "not", "no", "we", "our", "my", "its", "it's", "that", "this", "from", "by", "as", "are", "up"}
_MUST_FIX = ("invents", "starred claim")  # legal/brand risk: a rewrite that removes these always wins


def _invents(text: str | None, given: str) -> bool:
    return any(_norm(m) not in _norm(given) and m.replace(" ", "") not in given.replace(" ", "")
               for m in _CLAIM_RE.findall(text or ""))


def _scrub_claims(concepts: list[dict], given: str) -> None:
    """Last-resort safety net after the repair: an offer/claim the user never gave can't ship in the CTA or sub."""
    for c in concepts:
        if _invents(c.get("cta"), given):
            c["cta"] = "Try Xero today"
        if _invents(c.get("sub"), given):
            c["sub"] = None


def _clumsy(line: str | None) -> bool:
    """Cheap fluency gate for REWRITTEN copy only: repeated content words or a run-on headline.
    (Not used to flag first-pass copy: real Xero lines use deliberate repetition, e.g. "clear setup ... clear".)"""
    words = [w for w in re.findall(r"[a-z']+", (line or "").lower()) if w not in _STOP]
    return len(words) != len(set(words)) or len((line or "").split()) > 10


async def _repair_copy(messages: list[dict], result: list[dict], probs: list[str], ref_slots: dict | None,
                       given: str, deadline: float | None = None) -> list[dict]:
    """One compact rewrite call for the flagged lines only (fast: a small patch, not all concepts again).
    Per concept, the rewrite is kept only if it fixes a must-fix problem, or has fewer problems AND reads fluently;
    otherwise the first answer stays — never trade a natural line for a clumsy one."""
    flagged = {int(m) for m in re.findall(r"concept (\d+) ", " ".join(probs))}
    try:
        fix = await chat_json(messages + [
            {"role": "assistant", "content": json.dumps({"concepts": result}, ensure_ascii=False)},
            {"role": "user", "content": (
                "Problems: " + "; ".join(probs) + ".\nRewrite ONLY the flagged lines. Each new headline: 3-8 words of "
                "natural spoken English a senior Xero copywriter would sign off (read it aloud; no repeated words, no "
                "awkward wordplay), a concrete small-business benefit, sentence case, ending with a full stop. Find a "
                "genuinely different angle instead of lightly editing an existing Xero ad. No statistics, offers or "
                "claims the user didn't give. Return ONLY {\"fixes\": [{\"concept\": <number>, \"headline\"?: string, "
                "\"headline2\"?: string, \"sub\"?: string|null, \"cta\"?: string, \"disclaimer\"?: string|null}]} "
                "containing just the changed fields.")}],
            tier="pro", timeout=30, max_tokens=800, temperature=0.7, deadline=deadline)
    except Exception as e:  # noqa: BLE001
        log.warning("copy repair failed: %s", e)
        return result
    items = fix.get("fixes")
    if not isinstance(items, list):  # model ignored the patch format and sent full concepts back
        items = [{"concept": n, **c} for n, c in enumerate(fix.get("concepts") or [], 1) if isinstance(c, dict)]
    out = list(result)
    for f in items:
        try:
            i = int(f.get("concept"))
        except (AttributeError, TypeError, ValueError):
            continue
        if i not in flagged or not 1 <= i <= len(out):
            continue
        patch = {k: v for k, v in f.items() if k in ("headline", "headline2", "sub", "cta", "disclaimer")}
        cand = normalize_slots({**out[i - 1], **patch})
        mine = lambda ps: [p for p in ps if p.startswith(f"concept {i} ")]  # noqa: E731
        before = mine(_copy_problems(out, ref_slots, given))
        after = mine(_copy_problems(out[:i - 1] + [cand] + out[i:], ref_slots, given))
        must_before = any(k in p for p in before for k in _MUST_FIX)
        must_after = any(k in p for p in after for k in _MUST_FIX)
        fluent = not _clumsy(cand.get("headline")) and not _clumsy(cand.get("headline2"))
        if (must_before and not must_after) or (len(after) < len(before) and fluent):
            out[i - 1] = cand
        else:
            log.info("copy repair for concept %d rejected (fluent=%s, before=%s, after=%s)", i, fluent, before, after)
    return out


_HERO_WORDS = {"foodtruck": "food truck", "homeoffice": "home office", "laptop": "laptop"}
_CW_WORDS = {"light": "light", "dark": "navy", "blue": "blue"}


def _hero_label(hero: dict) -> str:
    t = hero.get("type")
    if t == "photo":
        tag = hero.get("photoTag") or "small-business"
        return f"{_HERO_WORDS.get(tag, tag)} photo"
    if t == "device":
        d = hero.get("deviceId") or ""
        return ("phone" if "phone" in d else "laptop" if "laptop" in d else "tablet" if "tablet" in d else "product") + \
            " with the Xero app"
    return "illustration" if t == "illustration" else ""


def _angle(plan, i: int) -> str | None:
    """Angle from the model's plan line "template/colourway - angle - hero", when it followed that format."""
    try:
        parts = [p.strip() for p in re.split(r"\s+[-–—]\s+", str(plan[i]))]
    except (IndexError, KeyError, TypeError):
        return None
    a = parts[1] if len(parts) >= 3 else ""
    if _CLAIM_RE.search(a):  # the plan may mention an offer the safety net removed
        return None
    return a[:1].upper() + a[1:] if 0 < len(a) <= 40 else None


_OFF_PALETTE = re.compile(r"\b(red|green|orange|purple|black|gold(?:en)?|silver|brown|gr[ae]y|maroon|teal|beige|"
                          r"burgundy|turquoise|neon|rainbow)\b", re.I)


def _palette_note(prompt: str) -> str | None:
    """Be open about a hard brand rule: off-palette colours in a request are mapped to the Xero palette."""
    asked = sorted({m.lower() for m in _OFF_PALETTE.findall(prompt or "")})
    if not asked:
        return None
    return (f"• Note: kept to the Xero palette ({' and '.join(asked)} aren't brand colours), "
            "so the theme comes through in the copy, photo and charms.")


def _concepts_reply(concepts: list[dict], plan, prompt: str = "") -> str:
    """Structured, factual chat reply built from the final concepts (the chat bubble keeps line breaks)."""
    note = _palette_note(prompt)
    def head(c: dict, i: int) -> str:
        bits = [_angle(plan, i), f"{c['template'].capitalize()} · {_CW_WORDS.get(c['colourway'], c['colourway'])}",
                _hero_label(c.get("hero") or {})]
        return " · ".join(b for b in bits if b)
    if len(concepts) == 1:
        c = concepts[0]
        return "\n".join(["Here's your ad:", head(c, 0), f"“{c['headline']}”", f"Button: {c['cta']}"] + ([note] if note else [])
                         + ["Tweak it in chat, e.g. “make it dark”, “new photo”, “make it 9:16”."])
    lines = [f"{len(concepts)} variations ready:"]
    for i, c in enumerate(concepts):
        lines += [f"{i + 1}. {head(c, i)}", f"“{c['headline']}”"]
    if note:
        lines.append(note)
    lines.append("Click one in the strip below the canvas to edit it.")
    return "\n".join(lines)


_THEME_SCENES = {
    "christmas": "decorated for Christmas: warm fairy lights, a wreath, a small Christmas tree and a festive shop window",
    "xmas": "decorated for Christmas: warm fairy lights, a wreath, a small Christmas tree and a festive shop window",
    "black friday": "busy Black Friday sale day: shop window with plain sale tags (no readable text), shoppers browsing",
    "halloween": "decorated for Halloween: carved pumpkins and warm autumn lights",
    "easter": "decorated for Easter: spring flowers and pastel decorations",
    "valentine": "decorated for Valentine's Day: red and pink flowers, hearts, soft warm light",
    "new year": "New Year celebration: warm string lights and a festive mood",
    "eofy": "end of the financial year: owner reviewing the year at the counter, calm and organised",
}


def _themed_scene(subject: str, theme: str | None) -> str:
    """photoPrompt for an Agent Mode hero: the subject in a theme-appropriate scene (style is added by images.py)."""
    if not theme:
        return f"smiling {subject} at work in their own small business"
    t = theme.lower()
    scene = next((v for k, v in _THEME_SCENES.items() if k in t), f"with clear {theme} decorations in the scene")
    # The trade must read near the person (not only in the far background); framing/headroom come from images.composition.
    return (f"smiling {subject} in their own small business, holding or showing what they make or sell so their "
            f"trade is obvious, {scene}")


def _subject_matches_bank(subject: str) -> bool:
    tag = fix_photo_tag(None, subject)
    if tag == "foodtruck" and not re.search(r"truck|street food", subject, re.I):
        return False  # e.g. "restaurant owner" aliases to foodtruck: a food-truck bank photo is the wrong business
    return tag != "cafe" or bool(re.search(r"caf[eé]|coffee|barista|espresso", subject, re.I))


def _subject_heroes(concepts: list[dict], subjects: list[str], theme: str | None, before: bool) -> None:
    """Agent Mode (spec §9): concept i shows subjects[i] in a themed scene; themed / unmatched subjects get no bank
    photo so the frontend generates one. `before` runs ahead of _diversify (hero type + prompt), after it the URLs."""
    for i, c in enumerate(concepts):
        subj = subjects[i] if i < len(subjects) else None
        hero = c.get("hero") or {}
        if before:
            if subj and c.get("template") not in ("card", "bold", "offer"):  # split/checklist take no photo hero
                taken = {x.get("template") for x in concepts if x is not c}
                t = next((t for t in ("offer", "card", "bold") if t not in taken), "card")
                c["template"] = t
                if c.get("colourway") not in TEMPLATE_COLOURWAYS[t]:
                    c["colourway"] = TEMPLATE_COLOURWAYS[t][0]
                c["ctaStyle"] = "navy" if t == "offer" else "sky"
                c["bloom"] = fix_bloom(c.get("bloom"), True)
            if theme and not re.search(re.escape(theme.split()[0]), f"{c.get('headline')} {c.get('sub') or ''}", re.I) \
                    and not c.get("sub"):
                c["sub"] = f"Xero keeps your books tidy this {theme}, so you can enjoy it."
            if subj:
                if hero.get("type") != "photo":
                    hero = {"type": "photo"}
                prompt = hero.get("photoPrompt") or ""
                if subj.lower().split()[0] not in prompt.lower() or (theme and theme.lower() not in prompt.lower()):
                    prompt = _themed_scene(subj, theme)
                hero["photoPrompt"] = prompt[:300]
                hero["photoTag"] = fix_photo_tag(None, subj)
                c["hero"] = hero
            elif theme and hero.get("type") == "photo":
                prompt = hero.get("photoPrompt") or PHOTO_SUBJECTS.get(hero.get("photoTag") or "", "small-business owner")
                if theme.lower() not in prompt.lower():
                    t = theme.lower()
                    scene = next((v for k, v in _THEME_SCENES.items() if k in t), f"with clear {theme} decorations")
                    hero["photoPrompt"] = f"{prompt.rstrip('. ')}, {scene}"[:300]
        elif hero.get("type") == "photo" and (theme or (subj and not _subject_matches_bank(subj))):
            hero.pop("photoUrl", None)


async def _concepts_with_image(messages: list[dict], url: str, count: int, deadline: float) -> tuple[list[dict], dict]:
    """"Like this" upload: the same prompt plus the image, on flash (pro is text-only).
    Any failure returns ([], {}) and the caller runs the usual text-only pro path."""
    try:
        last = messages[-1]
        text = (f"{last['content']}\n\nThe uploaded reference ad is attached as an image. Use it to match its layout, "
                "mood, imagery and hero subject more closely than the reference Slots alone describe. Still return "
                "only the JSON object.")
        msgs = messages[:-1] + [{"role": last["role"], "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": upload_data_url(url)}},
        ]}]
        data = await chat_json(msgs, tier="flash", timeout=45, max_tokens=6000, temperature=0.9, fallback=False,
                               deadline=deadline)
        raw = data.get("concepts")
        if isinstance(raw, dict):
            raw = [raw]
        result = [normalize_slots(c) for c in raw if isinstance(c, dict) and c.get("headline")] if isinstance(raw, list) else []
        if len(result) < count:
            raise ValueError(f"expected {count} concepts, got {len(result)}")
        log.info("concepts: built with the reference image (flash)")
        return result[:count], data
    except Exception as e:  # noqa: BLE001 — any failure falls back to the text-only path
        log.warning("concepts with reference image failed, falling back to text-only: %s", str(e)[:200])
        return [], {}


@app.post("/api/design/concepts")
async def concepts(req: ConceptsRequest) -> dict:
    t0 = time.perf_counter()
    deadline = t0 + CONCEPTS_BUDGET
    count = max(1, min(6, int(req.count or 1)))
    ref_entry = get_reference(req.referenceId) if req.referenceId else None
    ref_slots = req.reference or (ref_entry or {}).get("slots")
    ref_notes = (ref_entry or {}).get("notes")
    if ref_slots and count == 1 and (not req.prompt.strip() or _RECREATE.search(req.prompt)):
        rebuilt = [normalize_slots(ref_slots)]
        _apply_look(rebuilt, req.brief)  # Agent Mode "LOOK:" line only (no-op otherwise)
        return {"reply": "Here's the reference rebuilt as editable layers.", "concepts": rebuilt}

    subjects = [s for s in (re.sub(r"\s+", " ", str(x or "")).strip()[:80] for x in (req.subjects or [])) if s][:count]
    theme = re.sub(r"\s+", " ", req.theme or "").strip()[:40] or None
    messages = concepts_messages(req.prompt, count, ref_slots, req.size.model_dump(), req.brief, ref_notes,
                                 (ref_entry or {}).get("id"), subjects=subjects, theme=theme)
    if not ref_slots and count >= 3 and not subjects and not theme:
        mix = random.choice(_MIXES)[:count]
        messages[-1]["content"] += ("\n\nSuggested layout mix for this set (follow it unless the message clearly needs a "
                                    f"different template): {', '.join(mix)}. Use a device or illustration hero for at "
                                    "least one concept when the message is about the product.")
    data: dict = {}
    result: list[dict] = []
    if req.referenceImage and ref_slots and vision_supported("flash"):
        result, data = await _concepts_with_image(messages, req.referenceImage, count,
                                                  min(deadline, t0 + IMAGE_CONCEPTS_BUDGET))
    for attempt in range(0 if result else 2):  # skipped when the image path already produced the concepts
        try:
            data = await chat_json(messages, tier="pro", timeout=50, max_tokens=6000, temperature=0.9,
                                   deadline=deadline)
            raw = data.get("concepts")
            if isinstance(raw, dict):
                raw = [raw]
            if not isinstance(raw, list) or not raw:
                raise ValueError('missing "concepts" array')
            result = [normalize_slots(c) for c in raw if isinstance(c, dict) and c.get("headline")]
            if len(result) < count:
                raise ValueError(f'expected {count} concepts with a "headline", got {len(result)}')
            break
        except (BadJSON, ValueError) as e:
            log.warning("concepts attempt %d invalid: %s", attempt + 1, e)
            if attempt == 1:
                if result:
                    break
                raise HTTPException(502, f"Model returned invalid concepts: {e}")
            messages = messages + [{"role": "user", "content": f"Your previous output was invalid ({e}). Return "
                                    f"only the JSON object with exactly {count} complete Slots in \"concepts\"."}]
        except LLMError as e:
            raise HTTPException(503, f"LLM unavailable: {e}")
    result = result[:count]
    given = " ".join([req.prompt or "", req.brief or "", json.dumps(ref_slots or {}, ensure_ascii=False)])
    probs = _copy_problems(result, ref_slots, given)
    if probs:  # rewrite only the flagged lines; per concept keep whichever version is better
        log.info("concepts copy check: %s", probs)
        result = await _repair_copy(messages, result, probs, ref_slots, given, deadline)
    _scrub_claims(result, given)
    result = _keep_reference_structure(result, ref_slots)
    _fix_footnotes(result, ref_slots)
    for c in result:
        c["sub"] = _trim_sub(c.get("sub"))
    for c in result:  # URLs never come from the model (it may echo the reference's photo); bank picks below
        c["hero"].pop("photoUrl", None)
    if subjects or theme:
        _subject_heroes(result, subjects, theme, before=True)
    result = _diversify(result, ref_slots)
    _apply_look(result, req.brief)
    if subjects or theme:
        _subject_heroes(result, subjects, theme, before=False)
    reply = _concepts_reply(result, data.get("plan"), req.prompt)
    log.info("concepts count=%d ref=%s ms=%d", count, req.referenceId, int((time.perf_counter() - t0) * 1000))
    return {"reply": reply, "concepts": result}


# --------------------------------------------------------------------------------------------- edit

@app.post("/api/design/edit")
async def edit(req: EditRequest) -> dict:
    t0 = time.perf_counter()
    deadline = t0 + EDIT_BUDGET
    design = req.design or {}
    slots = req.slots or design.get("slots")
    if not slots and design.get("template"):  # at least let rebuilds know the current template/colourway
        slots = {k: design[k] for k in ("template", "colourway") if design.get(k)}
    summary = {k: design.get(k) for k in ("width", "height", "background", "template", "colourway") if k in design}
    summary["layers"] = []
    for l in design.get("layers") or []:
        if not isinstance(l, dict):
            continue
        s = {k: v for k, v in l.items() if k in ("id", "kind", "role", "text", "colour", "box")}
        if "box" not in s and all(k in l for k in ("x", "y", "width", "height")):  # a full Design was sent
            s["box"] = [round(float(l[k])) for k in ("x", "y", "width", "height")]
        if "colour" not in s and isinstance(l.get("fill") or l.get("colour"), str):
            s["colour"] = l.get("fill") or l.get("colour")
        summary["layers"].append(s)
    messages = edit_messages(req.message, summary, slots, [h.model_dump() for h in req.history])
    data: dict = {}
    for attempt in range(2):
        try:
            data = await chat_json(messages, tier="flash", timeout=20, max_tokens=2500, temperature=0.4,
                                   deadline=deadline)
            if not isinstance(data.get("ops", []), list):
                raise ValueError('"ops" must be an array')
            break
        except (BadJSON, ValueError) as e:
            log.warning("edit attempt %d invalid: %s", attempt + 1, e)
            if attempt == 1:
                raise HTTPException(502, f"Model returned invalid ops: {e}")
            messages = messages + [{"role": "user", "content": f"Your previous output was invalid ({e}). Return only "
                                    'the JSON object {"reply": string, "ops": [...]}.'}]
        except LLMError as e:
            raise HTTPException(503, f"LLM unavailable: {e}")
    # Split and checklist layouts can't hold a photo hero: a photo request moves the design to a layout that can.
    cur_tpl = (slots or {}).get("template") or design.get("template")
    for op in data.get("ops") or []:
        if isinstance(op, dict) and op.get("op") == "rebuild" and isinstance(op.get("slots"), dict):
            s = op["slots"]
            if (s.get("hero") or {}).get("type") == "photo" and (s.get("template") or cur_tpl) in ("split", "checklist"):
                cw = s.get("colourway") or (slots or {}).get("colourway") or design.get("colourway") or "light"
                s["template"] = "bold" if cw in ("dark", "blue") else "card"
            # A layout switch keeps existing copy: only clear sub/disclaimer/stat when the user asked to remove something.
            if not _REMOVE_ASK.search(req.message):
                for k in ("sub", "disclaimer", "stat", "items"):
                    if k in s and s[k] in (None, "", []) and (slots or {}).get(k):
                        del s[k]
    ops = normalize_ops(data.get("ops") or [], design, slots)
    # Crop complaints: the model can't see the photo, so replace its focus/zoom/geometry guesses with a reframe.
    photo_ids = {l.get("id") for l in design.get("layers") or [] if isinstance(l, dict) and l.get("kind") == "photo"}
    if photo_ids and _CROP_ASK.search(req.message) and _PHOTO_WORDS.search(req.message):
        crop_keys = {"focusX", "focusY", "zoom", "x", "y", "width", "height"}
        kept = [o for o in ops if not (o["op"] == "update" and o["id"] in photo_ids and set(o["props"]) <= crop_keys)]
        targets = sorted({o["id"] for o in ops if o["op"] == "update" and o["id"] in photo_ids} | {
            o["id"] for o in ops if o["op"] == "reframe"}) or sorted(photo_ids)[:1]
        ops = [o for o in kept if o["op"] != "reframe"] + [{"op": "reframe", "id": t} for t in targets]
    reply = str(data.get("reply") or "").strip() or ("• Done" if ops else "I couldn't find anything to change there.")
    reply = re.sub(r"\*\*(.+?)\*\*", r"\1", reply)  # the chat bubble is plain text: drop markdown bold
    log.info("edit ops=%d ms=%d", len(ops), int((time.perf_counter() - t0) * 1000))
    return {"reply": reply, "ops": ops}


# --------------------------------------------------------------------------------------------- images

@app.post("/api/photo")
async def photo(req: PhotoRequest) -> dict:
    subject = req.prompt.strip()
    if not subject:
        tag = fix_photo_tag(req.tag)
        subject = PHOTO_SUBJECTS[tag]
    orientation = images.orientation_for(req.aspect, req.orientation)
    # Shape-aware: the visible region (box fractions) mapped onto the image the editor will cover-fit over the box, so
    # the subject is composed where it will be seen; else headroom + margins for the bloom/frame.
    region = images.image_region(req.region, req.aspect, orientation)
    comp = images.composition(req.fit, region)
    if comp:
        subject = f"{subject.rstrip('. ')}. {comp}"
    if region:
        log.info("photo region box=%s image=%s orientation=%s", req.region, region, orientation)
    try:
        out = await images.generate(subject, orientation, req.quality)
    except Exception as e:  # noqa: BLE001
        log.warning("photo generation failed: %s", e)
        raise HTTPException(502, f"Image generation failed: {type(e).__name__}: {str(e)[:200]}")
    out.update(await images.locate_subject(out["url"]))  # focus + box, so frameSubject keeps the subject in view
    return out


@app.post("/api/pixel-edit")
async def pixel_edit(req: PixelEditRequest) -> dict:
    try:
        return await images.edit(req.url, req.prompt)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, f"Bad image url: {e}")
    except Exception as e:  # noqa: BLE001
        log.warning("pixel edit failed: %s", e)
        raise HTTPException(502, f"Image edit failed: {type(e).__name__}: {str(e)[:200]}")


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 25 MB)")
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Not an image")
    ext = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}.get(img.format or "", None)
    name = f"{uuid.uuid4().hex[:12]}.{ext or 'png'}"
    path = UPLOADS_DIR / name
    if ext:
        path.write_bytes(raw)
    else:
        img.save(path, "PNG")
    return {"url": f"/static/uploads/{name}", "w": img.width, "h": img.height}


@app.post("/api/analyze")
async def analyze(req: UrlRequest) -> dict:
    try:
        return await analyze_image(req.url)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, f"Bad image url: {e}")
