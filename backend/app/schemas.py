"""Pydantic models mirroring frontend/src/types.ts + forgiving normalisers for LLM output.

Policy: never fail on a bad enum - coerce to a sensible default; clamp lists; drop unknown asset names.
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator

from . import assets as A

# --------------------------------------------------------------------------------------------- models


class Hero(BaseModel):
    type: Literal["photo", "device", "illustration", "none"] = "photo"
    photoTag: Optional[str] = None
    photoPrompt: Optional[str] = None
    photoUrl: Optional[str] = None
    deviceId: Optional[str] = None
    illustrationId: Optional[str] = None


class StatSpec(BaseModel):
    label: str
    value: str
    variant: Literal["sparkline", "check", "area", "bars"] = "sparkline"


class CharmSpec(BaseModel):
    charm: str
    colour: Literal["blue", "green", "yellow", "pink", "purple"]


class Slots(BaseModel):
    template: Literal["card", "bold", "checklist", "split", "offer"] = "card"
    colourway: Literal["light", "dark", "blue"] = "light"
    headline: str
    headline2: Optional[str] = None
    sub: Optional[str] = None
    cta: str
    ctaStyle: Optional[Literal["sky", "navy", "white"]] = None
    disclaimer: Optional[str] = None
    items: Optional[list[str]] = None
    tags: bool = False
    stat: Optional[StatSpec] = None
    hero: Hero = Field(default_factory=Hero)
    bloom: Optional[str] = None
    charms: list[CharmSpec] = Field(default_factory=list)
    market: Optional[str] = None


class Size(BaseModel):
    width: int = 1080
    height: int = 1350


class ConceptsRequest(BaseModel):
    prompt: str = ""
    count: int = 4
    referenceId: Optional[str] = None
    reference: Optional[dict] = None
    size: Size = Field(default_factory=Size)
    brief: Optional[str] = None
    subjects: Optional[list[str]] = None  # Agent Mode: one hero subject per concept, in order (spec §9)
    theme: Optional[str] = None  # Agent Mode: campaign theme heard in every concept's copy and photo scene
    referenceImage: Optional[str] = None  # /static/uploads/... of the uploaded ad: tried on the vision tier first


class ConceptsResponse(BaseModel):
    reply: str
    concepts: list[dict]


class HistoryItem(BaseModel):
    role: Literal["user", "assistant"] = "user"
    content: str = ""


class EditRequest(BaseModel):
    message: str
    design: dict
    slots: Optional[dict] = None
    history: list[HistoryItem] = Field(default_factory=list)


class EditResponse(BaseModel):
    reply: str
    ops: list[dict]


class PhotoRequest(BaseModel):
    prompt: str
    tag: Optional[str] = None
    orientation: Literal["landscape", "square", "portrait"] = "landscape"
    quality: Literal["low", "medium", "high"] = "medium"
    aspect: Optional[float] = None  # w/h of the layer box the image covers: overrides orientation when given
    fit: Optional[str] = None  # 'bloom' | 'frame' | 'full': adds a composition clause (headroom, margins)
    # Visible part of the box [x0, y0, x1, y1] (box fractions): the subject is composed inside it. Bad values -> None.
    region: Optional[list[float]] = None

    @field_validator("region", mode="before")
    @classmethod
    def _clean_region(cls, v: Any) -> Optional[list[float]]:
        """4 finite numbers in 0..1 with x0 < x1 and y0 < y1, else ignored (None) - never a 422."""
        if not isinstance(v, (list, tuple)) or len(v) != 4:
            return None
        try:
            x0, y0, x1, y1 = (float(a) for a in v)
        except (TypeError, ValueError):
            return None
        if any(isinstance(a, bool) for a in v) or not all(0.0 <= a <= 1.0 for a in (x0, y0, x1, y1)):
            return None  # NaN fails the range check too
        return [x0, y0, x1, y1] if x0 < x1 and y0 < y1 else None


class UrlRequest(BaseModel):
    url: str


class PixelEditRequest(BaseModel):
    url: str
    prompt: str


class ImageResult(BaseModel):
    url: str
    w: int
    h: int


# Ops (documentation / typing; normalisation below is what is enforced)
class OpUpdate(BaseModel):
    op: Literal["update"]
    id: str
    props: dict


class OpAdd(BaseModel):
    op: Literal["add"]
    layer: dict
    index: Optional[int] = None


class OpDelete(BaseModel):
    op: Literal["delete"]
    id: str


class OpReorder(BaseModel):
    op: Literal["reorder"]
    id: str
    to: Literal["front", "back", "forward", "backward"]


class OpRebuild(BaseModel):
    op: Literal["rebuild"]
    slots: dict


class OpResize(BaseModel):
    op: Literal["resize"]
    width: int
    height: int


class OpPhoto(BaseModel):
    op: Literal["photo"]
    id: str
    prompt: str


class OpPixelEdit(BaseModel):
    op: Literal["pixel_edit"]
    id: str
    prompt: str


Op = Union[OpUpdate, OpAdd, OpDelete, OpReorder, OpRebuild, OpResize, OpPhoto, OpPixelEdit]

# --------------------------------------------------------------------------------------------- helpers

def _s(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ("" if v is None else str(v).strip())


def _opt_s(v: Any) -> str | None:
    s = _s(v)
    return s or None


def _enum(v: Any, allowed: list[str], default: str | None) -> str | None:
    s = _s(v).lower()
    return s if s in allowed else default


_KEEP_CASE = {"xero", "xero's", "i", "i'm", "i've", "i'll", "hmrc", "mtd", "vat", "gst", "uk", "au", "nz", "za", "us",
              "ai", "amazon", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "sundays",
              "mondays", "fridays", "saturdays", "january", "february", "april", "june", "july", "august",
              "september", "october", "november", "december", "coach", "income", "tax"}


def sentence_case(text: str) -> str:
    """Convert Title Case headlines to sentence case (keeps Xero, acronyms, proper nouns, sentence starts)."""
    words = text.split()
    if len(words) < 3:
        return text
    starts = {0} | {i + 1 for i, w in enumerate(words) if w.endswith((".", "?", "!"))}

    def core(w: str) -> str:
        return re.sub(r"[^\w']", "", w).lower()

    cands = [w for i, w in enumerate(words) if i not in starts and core(w) not in _KEEP_CASE
             and not (w.isupper() and len(core(w)) > 1) and core(w)[:1].isalpha()]
    caps = [w for w in cands if w[:1].isupper()]
    if len(caps) < 2 or len(caps) < 0.6 * len(cands):
        return text  # already sentence case (a capitalised proper noun or two is fine)
    out = []
    for i, w in enumerate(words):
        if i in starts:
            out.append(w[:1].upper() + w[1:])
        elif (w.isupper() and len(core(w)) > 1) or core(w) in _KEEP_CASE:
            out.append(w)
        else:
            out.append(w.lower())
    return " ".join(out)


def fix_headline(text: str) -> str:
    t = re.sub(r"\s+", " ", _s(text)).strip(' "“”')
    if not t:
        return t
    t = sentence_case(t)
    t = t[:1].upper() + t[1:]
    if t[-1] == "*" and len(t) > 1 and t[-2] in ".?!":  # footnote marker after the full stop: "easy to use.*"
        return t
    if t[-1] not in ".?!":
        t = t.rstrip(",;:-") + "."
    return t


def fix_cta(text: str) -> str:
    t = re.sub(r"\s+", " ", _s(text)).strip(' "')
    t = t.rstrip(".!")
    return t[:1].upper() + t[1:] if t else t


_MARKETS = {"UK": "UK", "GB": "UK", "UNITED KINGDOM": "UK", "BRITAIN": "UK", "ENGLAND": "UK",
            "AU": "AU", "AUSTRALIA": "AU", "NZ": "NZ", "NEW ZEALAND": "NZ", "ZA": "ZA", "SOUTH AFRICA": "ZA",
            "US": "US", "USA": "US", "UNITED STATES": "US", "AMERICA": "US"}
CURRENCY = {"UK": "£", "AU": "$", "NZ": "$", "US": "$", "ZA": "R"}


def fix_market(v: Any) -> str | None:
    s = _s(v).upper()
    if not s:
        return None
    return _MARKETS.get(s, s[:12])


def localise(text: str | None, market: str | None) -> str | None:
    """Swap currency symbols in front of amounts to the market's currency."""
    if not text or market not in CURRENCY:
        return text
    sym = CURRENCY[market]
    return re.sub(r"(?<![A-Za-z])(?:£|\$|€|R)\s?(?=\d)", sym, text)


_OFFER_RE = re.compile(r"%|\*|[£$€]\s?\d|(?<![A-Za-z])R\s?\d|\bfree\b|\bvoucher|\boff\b|\bdiscount", re.I)


def has_offer(*texts: str | None) -> bool:
    return any(t and _OFFER_RE.search(t) for t in texts)


_TAG_ALIASES = [
    (r"flor|flower|bouquet", "florist"), (r"caf[eé]|coffee|barista|espresso", "cafe"),
    (r"bak|bread|pastr|cake", "bakery"), (r"boutique|cloth|fashion|retail|shop|store", "boutique"),
    (r"wood|carpent|joiner|furniture", "woodworker"),
    (r"maker|artisan|craft|potter|ceramic|studio|jewel|hat|textile|sew", "maker"),
    (r"plumb|electric|tradie|trade|mechanic|van|tool", "tradie"), (r"build|construct|site|architect", "builder"),
    (r"bee|honey", "beekeeper"), (r"truck|food|street|chef|restaurant|kitchen", "foodtruck"),
    (r"salon|hair|barber|beauty|nail|stylist", "salon"), (r"farm|crop|harvest|orchard|vineyard|garden", "farmer"),
    (r"laptop|desk|computer|typing|accountant|bookkeep|adviser|advisor", "laptop"),
    (r"home|office|remote|kitchen table|couch|living", "homeoffice"),
]


def fix_photo_tag(tag: Any, prompt: str | None = None) -> str:
    t = _s(tag).lower().replace(" ", "").replace("_", "").replace("-", "")
    if t in A.PHOTO_TAGS:
        return t
    for text in (t, (prompt or "").lower()):
        if not text:
            continue
        for pat, name in _TAG_ALIASES:
            if re.search(pat, text):
                return name
    return "cafe"


PHOTO_SUBJECTS = {
    "florist": "smiling florist arranging a bouquet in her flower shop",
    "cafe": "smiling cafe owner behind the counter of a cosy neighbourhood cafe",
    "bakery": "smiling baker taking fresh loaves out of the oven in a small bakery",
    "boutique": "smiling boutique owner folding clothes at the counter of her clothing store",
    "maker": "smiling artisan maker at work in a sunny craft studio",
    "woodworker": "woodworker planing a plank at his bench, wood shavings around",
    "tradie": "smiling tradesperson with a toolbox next to their work van",
    "builder": "smiling builder holding rolled-up plans on a construction site",
    "beekeeper": "beekeeper holding up a honeycomb frame, golden afternoon light",
    "foodtruck": "smiling food-truck owner leaning on the serving counter of his truck",
    "salon": "smiling hairdresser styling a client's hair in a bright salon",
    "farmer": "smiling farmer holding a crate of fresh vegetables in a field",
    "homeoffice": "small-business owner working happily at the kitchen table at home",
    "laptop": "hands typing on a laptop on a wooden desk with a coffee cup",
}

_CHARM_ALIASES = {
    "star": "sparkle", "sparkles": "sparkle", "stars": "sparkle", "shine": "sparkle", "love": "heart", "hearts": "heart",
    "tick": "check", "checkmark": "check", "check_mark": "check", "done": "check", "tickbox": "checkbox",
    "check_box": "checkbox", "todo": "checkbox", "timer": "hourglass", "sand_timer": "hourglass", "time": "clock",
    "alarm": "clock", "watch": "clock", "percentage": "percent", "coin_percent": "percent", "discount": "percent",
    "coins": "coin", "cash": "money", "banknote": "money", "notes": "money", "money_bag": "money", "dollar": "money",
    "coffee": "mug", "cup": "mug", "tea": "mug", "present": "gift", "voucher": "gift", "lightbulb": "bulb",
    "light_bulb": "bulb", "idea": "bulb", "pie_chart": "pie", "piechart": "pie", "bar_chart": "bars", "chart": "bars",
    "barchart": "bars", "graph": "bars", "chat_bubble": "chat", "speech": "chat", "bubble": "chat", "message": "chat",
    "airplane": "plane", "aeroplane": "plane", "paper_plane": "plane", "send": "plane", "thumbs_up": "thumbs",
    "thumb": "thumbs", "like": "thumbs", "date": "calendar", "schedule": "calendar", "notification": "bell",
    "security": "shield", "secure": "shield", "award": "trophy", "cup_trophy": "trophy", "padlock": "lock",
    "search": "magnifier", "magnifying_glass": "magnifier", "credit_card": "card", "payment": "card",
    "building": "bank", "world": "globe", "earth": "globe", "files": "folder", "computer": "laptop",
    "mobile": "phone", "smartphone": "phone",
}
_CHARM_DEFAULT_COLOUR = {"check": "green", "checkbox": "green", "heart": "pink", "sparkle": "yellow", "mug": "purple",
                         "hourglass": "purple", "money": "green", "gift": "pink", "bulb": "yellow", "pie": "green",
                         "bars": "green", "plane": "pink", "chat": "yellow", "percent": "yellow", "coin": "yellow"}
_CHARM_COLOUR_ALIASES = {"lilac": "purple", "violet": "purple", "mint": "green", "sky": "blue", "navy": "blue",
                         "gold": "yellow", "orange": "yellow", "red": "pink", "magenta": "pink"}


def fix_charm_name(v: Any) -> str | None:
    known = A.charm_types()
    s = _s(v).lower().replace(" ", "_").replace("-", "_")
    if s in known:
        return s
    a = _CHARM_ALIASES.get(s)
    if a and a in known:
        return a
    if s.endswith("s") and s[:-1] in known:
        return s[:-1]
    return None


def fix_charms(raw: Any, limit: int = 3) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    if not isinstance(raw, list):
        return out
    for c in raw:
        if isinstance(c, str):
            c = {"charm": c}
        if not isinstance(c, dict):
            continue
        name = fix_charm_name(c.get("charm") or c.get("type") or c.get("name"))
        if not name or name in seen:
            continue
        col = _s(c.get("colour") or c.get("color")).lower()
        col = _CHARM_COLOUR_ALIASES.get(col, col)
        avail = A.charm_colours(name)
        if col not in avail:
            d = _CHARM_DEFAULT_COLOUR.get(name, "yellow")
            col = d if d in avail else avail[0]
        out.append({"charm": name, "colour": col})
        seen.add(name)
        if len(out) >= limit:
            break
    return out


def fix_bloom(v: Any, chunky: bool) -> str:
    s = _s(v).lower()
    s = A.OLD_BLOOM_NAMES.get(s, s)
    if chunky:
        return s if s in A.PHOTO_MASKS else "harmony"
    return s if s in A.BLOOM_SHAPES else "harmony"


def fix_hero(raw: Any) -> dict:
    if isinstance(raw, str):
        raw = {"type": raw}
    if not isinstance(raw, dict):
        raw = {}
    t = _enum(raw.get("type"), A.HERO_TYPES, None)
    device, illus = _s(raw.get("deviceId")), _s(raw.get("illustrationId"))
    if t is None:
        t = "device" if device else "illustration" if illus else "photo"
    hero: dict = {"type": t}
    if t == "device":
        if device in A.devices():
            hero["deviceId"] = device
        else:
            t = hero["type"] = "photo"
    if t == "illustration":
        if illus in A.illustrations():
            hero["illustrationId"] = illus
        else:
            t = hero["type"] = "photo"
    if t == "photo":
        prompt = _s(raw.get("photoPrompt"))
        tag = fix_photo_tag(raw.get("photoTag"), prompt)
        hero["photoTag"] = tag
        hero["photoPrompt"] = prompt or PHOTO_SUBJECTS[tag]
        url = raw.get("photoUrl")
        if isinstance(url, str) and url.startswith("/static/"):
            hero["photoUrl"] = url
    return hero


# template -> allowed colourways; first = default
TEMPLATE_COLOURWAYS = {"card": ["light", "dark", "blue"], "bold": ["dark", "blue"], "checklist": ["dark", "blue"],
                       "split": ["light"], "offer": ["light"]}
# allowed CTA styles per template/colourway (contrast with what is behind the button); first = default
def cta_styles(template: str, colourway: str) -> list[str]:
    if template == "card":
        return ["sky", "navy"]  # sits on the white card
    if template == "split":
        return ["white", "navy"]
    if template == "offer" or colourway == "light":
        return ["navy", "white"]
    return ["sky", "white"]  # dark / blue backgrounds


def fit_template(template: str, colourway: str) -> tuple[str, str]:
    """Keep the user's colourway where possible by switching to the sibling template."""
    if colourway in TEMPLATE_COLOURWAYS[template]:
        return template, colourway
    if template == "bold" and colourway == "light":
        return "offer", "light"
    if template == "offer" and colourway in ("dark", "blue"):
        return "bold", colourway
    return template, TEMPLATE_COLOURWAYS[template][0]


def normalize_slots(raw: Any) -> dict:
    """Full Slots from loose LLM output. Never raises."""
    if not isinstance(raw, dict):
        raw = {}
    template = _enum(raw.get("template"), A.TEMPLATES, "card")
    colourway = _enum(raw.get("colourway") or raw.get("colorway"), A.COLOURWAYS, None)
    if colourway is None:
        colourway = TEMPLATE_COLOURWAYS[template][0]
    template, colourway = fit_template(template, colourway)
    market = fix_market(raw.get("market"))
    hero = fix_hero(raw.get("hero"))
    # hero types each template can lay out (CONTRACT "Templates")
    if template == "checklist":
        hero = {"type": "none"}
    elif template == "split":
        if hero["type"] != "device":
            devs = [d for d in A.devices() if "phone" in d] or list(A.devices())
            hero = {"type": "device", "deviceId": devs[0]} if devs else hero
    elif hero["type"] == "illustration" and template != "bold":
        hero = fix_hero({"type": "photo", "photoPrompt": _s((raw.get("hero") or {}).get("photoPrompt"))
                         if isinstance(raw.get("hero"), dict) else ""})
    elif hero["type"] == "none" and template in ("bold", "offer"):
        hero = fix_hero({"type": "photo", "photoPrompt": "", "photoTag": fix_photo_tag(None, _s(raw.get("headline")))})
    headline = fix_headline(localise(raw.get("headline"), market) or "") or "Run your business, not your books."
    cta = fix_cta(localise(raw.get("cta"), market) or "") or "Try Xero for free"
    sub = _opt_s(localise(raw.get("sub"), market))
    headline2 = fix_headline(raw.get("headline2") or "") if template == "split" and _s(raw.get("headline2")) else None
    items = raw.get("items")
    if template == "checklist":
        items = [re.sub(r"\s+", " ", _s(i)).rstrip(".") for i in (items if isinstance(items, list) else []) if _s(i)][:3]
        if len(items) < 3:
            items += ["Invoices sent", "Bills paid", "Payroll done"][len(items):3]
    else:
        items = None
    stat = raw.get("stat")
    if isinstance(stat, dict) and _s(stat.get("label")) and _s(stat.get("value")):
        stat = {"label": _s(stat["label"])[:28], "value": localise(_s(stat["value"]), market)[:16],
                "variant": _enum(stat.get("variant"), A.STAT_VARIANTS, "sparkline")}
    else:
        stat = None
    disclaimer = _opt_s(raw.get("disclaimer"))
    if not disclaimer and has_offer(headline, headline2, sub, cta):
        disclaimer = "Terms apply."
    styles = cta_styles(template, colourway)
    cta_style = _enum(raw.get("ctaStyle"), A.CTA_STYLES, None)
    if cta_style not in styles:
        cta_style = styles[0]
    chunky = hero["type"] in ("photo", "device")
    out = {
        "template": template, "colourway": colourway, "headline": headline, "headline2": headline2, "sub": sub,
        "cta": cta, "ctaStyle": cta_style, "disclaimer": disclaimer, "items": items,
        "tags": bool(raw.get("tags")) if not isinstance(raw.get("tags"), str) else raw["tags"].lower() == "true",
        "stat": stat, "hero": hero, "bloom": fix_bloom(raw.get("bloom"), chunky),
        "charms": fix_charms(raw.get("charms")),
    }
    if market:
        out["market"] = market
    Slots.model_validate(out)  # shape guarantee (raises only on a programming error)
    return out


def normalize_partial_slots(raw: Any, current: dict | None) -> dict:
    """Partial<Slots> for a rebuild op: only keys the model set; explicit nulls kept for nullable fields."""
    if not isinstance(raw, dict):
        return {}
    raw = {("colourway" if k == "colorway" else k): v for k, v in raw.items()}
    cur = current if isinstance(current, dict) else {}
    full = normalize_slots({**cur, **raw})
    out: dict = {}
    for k, v in raw.items():
        if k in ("sub", "disclaimer", "headline2", "stat", "items") and v in (None, "", []):
            out[k] = None
        elif k in full:
            out[k] = full[k]
    if cur:  # knock-on fixes the normaliser made (template/colourway pairing, CTA contrast, disclaimer, mask)
        knock = ["template", "colourway", "ctaStyle"] + (["disclaimer"] if cur.get("headline") else []) + \
                (["bloom", "hero"] if cur.get("hero") and ("hero" in raw or "template" in raw) else [])
        for k in knock:
            if k == "hero" and k not in out:
                strip = lambda h: {a: b for a, b in (h or {}).items() if a != "photoUrl" and b is not None}  # noqa: E731
                if strip(full["hero"]) == strip(cur.get("hero")):
                    continue
            if k not in out and full.get(k) != cur.get(k):
                out[k] = full[k]
        cur_hero = cur.get("hero") or {}
        if isinstance(out.get("hero"), dict) and out["hero"].get("type") == "photo" and cur_hero.get("photoUrl") \
                and out["hero"].get("photoTag") == cur_hero.get("photoTag") and "photoPrompt" not in (raw.get("hero") or {}):
            out["hero"]["photoUrl"] = cur_hero["photoUrl"]
    elif "template" in raw:
        out["template"], out["colourway"], out["ctaStyle"] = full["template"], full["colourway"], full["ctaStyle"]
    return out


# --------------------------------------------------------------------------------------------- ops

LAYER_KINDS = ["rect", "text", "button", "logo", "bloom", "bgshape", "charm", "image", "photo", "tags", "stat"]
_NUM = {"x", "y", "width", "height", "rotation", "opacity", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
        "cornerRadius", "zoom", "focusX", "focusY"}
_BOOL = {"locked", "hidden", "uppercase", "flipX", "flipY"}
_STR = {"text", "name", "label", "value"}


def _colour_prop(key: str, v: Any, kind: str) -> Any:
    s = _s(v).lower()
    if s.startswith("#") or re.fullmatch(r"[0-9a-f]{6}", s):
        allowed = {"logo": A.LOGO_COLOURS, "bgshape": A.CORE_COLOURS}.get(kind, A.COLOUR_TOKENS)
        if kind == "text" and key == "fill":
            allowed = A.TEXT_COLOURS
        return A.nearest_token(s if s.startswith("#") else "#" + s, allowed)
    s = {"light blue": "sky", "lightblue": "sky", "cyan": "sky", "dark blue": "navy", "darkblue": "navy",
         "purple": "lilac", "green": "mint"}.get(s, s)
    if kind == "charm":
        s = _CHARM_COLOUR_ALIASES.get(s, s)
        return s if s in A.CHARM_COLOURS else None
    if kind == "logo" or key == "pill":
        return s if s in A.LOGO_COLOURS else None
    if kind == "bgshape":
        return s if s in A.CORE_COLOURS else None
    if kind == "text" and key == "fill":
        return s if s in A.TEXT_COLOURS else None
    return s if s in A.COLOUR_TOKENS else None


def clean_props(props: Any, kind: str) -> dict:
    if not isinstance(props, dict):
        return {}
    out: dict = {}
    for k, v in props.items():
        if k in ("id", "kind", "role", "src", "assetId"):
            continue
        if k in _NUM:
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            if k == "opacity":
                f = min(1.0, max(0.0, f))
            if k in ("width", "height", "fontSize", "zoom") and f <= 0:
                continue
            out[k] = round(f, 3)
        elif k in _BOOL:
            out[k] = bool(v)
        elif k in ("fill", "textFill", "colour", "color", "pill"):
            key = "colour" if k == "color" else k
            if key == "pill" and v in (None, "", "none", False):
                out["pill"] = None
                continue
            c = _colour_prop(key, v, kind)
            if c:
                out[key] = c
        elif k in _STR:
            out[k] = _s(v)
        elif k == "align":
            a = _enum(v, ["left", "center", "right"], None) or ("center" if _s(v).lower() == "centre" else None)
            if a:
                out[k] = a
        elif k == "items" and isinstance(v, list):
            out[k] = [_s(i) for i in v if _s(i)][:8]
        elif k == "charm":
            c = fix_charm_name(v)
            if c:
                out[k] = c
        elif k in ("shape", "mask"):
            if k == "mask" and v in (None, "", "none"):
                out[k] = None
            else:
                out[k] = fix_bloom(v, chunky=(k == "mask" or kind == "photo"))
        elif k == "variant":
            out[k] = _enum(v, A.STAT_VARIANTS, "sparkline")
        elif k == "columns":
            try:
                n = int(v)
                out[k] = n if n in (1, 2, 4) else 4
            except (TypeError, ValueError):
                pass
        elif k == "prompt":
            out[k] = _s(v)
    return out


def _new_id(existing: set[str], prefix: str = "ai") -> str:
    while True:
        i = f"{prefix}_{uuid.uuid4().hex[:6]}"
        if i not in existing:
            existing.add(i)
            return i


def normalize_ops(raw_ops: Any, design: dict, current_slots: dict | None) -> list[dict]:
    """Validate ops against the design: unknown layer ids dropped, colours -> tokens, slots normalised."""
    layers = design.get("layers") or []
    by_id = {l.get("id"): l for l in layers if isinstance(l, dict) and l.get("id")}
    ids = set(by_id)
    W = float(design.get("width") or 1080)
    H = float(design.get("height") or 1350)
    ops: list[dict] = []
    if not isinstance(raw_ops, list):
        return ops
    for op in raw_ops:
        if not isinstance(op, dict):
            continue
        kind_ = _s(op.get("op")).lower()
        if kind_ in ("create", "restyle", "recreate"):
            kind_ = "rebuild"
        if kind_ == "update":
            lid = op.get("id")
            if lid not in by_id:
                continue
            props = clean_props(op.get("props") or {k: v for k, v in op.items() if k not in ("op", "id")},
                                by_id[lid].get("kind", ""))
            if by_id[lid].get("role") == "headline" and "text" in props:
                props["text"] = fix_headline(props["text"])
            if by_id[lid].get("role") == "cta" and "text" in props:
                props["text"] = fix_cta(props["text"])
            if by_id[lid].get("kind") == "button" and "fill" in props:
                if props["fill"] not in A.CTA_STYLES:
                    props["fill"] = "navy" if props["fill"] in ("blue", "lilac") else "sky"
                if props.get("textFill") not in A.TEXT_COLOURS or props.get("textFill") == props["fill"]:
                    props["textFill"] = "white" if props["fill"] == "navy" else "navy"
            if props:
                ops.append({"op": "update", "id": lid, "props": props})
        elif kind_ == "delete":
            if op.get("id") in by_id:
                ops.append({"op": "delete", "id": op["id"]})
        elif kind_ == "reorder":
            to = _enum(op.get("to"), ["front", "back", "forward", "backward"], None)
            if op.get("id") in by_id and to:
                ops.append({"op": "reorder", "id": op["id"], "to": to})
        elif kind_ == "rebuild":
            slots = normalize_partial_slots(op.get("slots") or {}, current_slots)
            if slots:
                ops.append({"op": "rebuild", "slots": slots})
        elif kind_ in ("reframe", "recenter", "recentre", "refocus", "reframe_photo"):
            # Code re-aims the crop at the person (the model never sees the pixels, so it must not guess focus values).
            lid = op.get("id")
            if lid not in by_id or by_id[lid].get("kind") != "photo":
                photos = [l for l in layers if isinstance(l, dict) and l.get("kind") == "photo"]
                lid = photos[0]["id"] if photos else None
            if lid and not any(o.get("op") == "reframe" and o.get("id") == lid for o in ops):
                ops.append({"op": "reframe", "id": lid})
        elif kind_ == "resize":
            try:
                w, h = int(float(op.get("width"))), int(float(op.get("height")))
            except (TypeError, ValueError):
                continue
            if 200 <= w <= 4096 and 200 <= h <= 4096:
                ops.append({"op": "resize", "width": w, "height": h})
        elif kind_ in ("photo", "pixel_edit"):
            prompt = _s(op.get("prompt"))
            if not prompt:
                continue
            lid = op.get("id")
            if kind_ == "photo":
                if lid not in by_id or by_id[lid].get("kind") != "photo":
                    photos = [l for l in layers if isinstance(l, dict) and l.get("kind") == "photo"]
                    if photos:
                        lid = photos[0]["id"]
                    else:  # no photo layer yet: switch the hero to a photo via rebuild
                        ops.append({"op": "rebuild", "slots": {"hero": fix_hero(
                            {"type": "photo", "photoPrompt": prompt, "photoTag": fix_photo_tag(None, prompt)}),
                            "bloom": fix_bloom((current_slots or {}).get("bloom"), True)}})
                        continue
                ops.append({"op": "photo", "id": lid, "prompt": prompt})
            else:
                if lid not in by_id or by_id[lid].get("kind") not in ("photo", "image"):
                    continue
                ops.append({"op": "pixel_edit", "id": lid, "prompt": prompt})
        elif kind_ == "add":
            layer = op.get("layer") if isinstance(op.get("layer"), dict) else None
            if not layer:
                continue
            lk = _s(layer.get("kind")).lower()
            if lk not in LAYER_KINDS or lk in ("image", "photo"):
                continue  # images/photos come from the photo op or the brand panel, not from the LLM
            new = clean_props(layer, lk)
            new["kind"] = lk
            new["id"] = _new_id(ids)
            role = _s(layer.get("role"))
            if role:
                new["role"] = role
            for k, d in (("x", W * 0.1), ("y", H * 0.1), ("width", W * 0.15), ("height", W * 0.15)):
                new.setdefault(k, round(d, 1))
            if lk == "charm":
                if "charm" not in new:
                    continue
                avail = A.charm_colours(new["charm"])
                if new.get("colour") not in avail:
                    d = _CHARM_DEFAULT_COLOUR.get(new["charm"], "yellow")
                    new["colour"] = d if d in avail else avail[0]
                new.setdefault("role", "charm")
                new["height"] = round(new["width"] * A.charm_aspect(new["charm"]), 1)  # never stretched
            elif lk == "bloom":
                new.setdefault("shape", "harmony")
                new.setdefault("colour", "sky")
                new.setdefault("role", "bloom")
            elif lk == "text":
                if not new.get("text"):
                    continue
                new.setdefault("font", "body")
                new.setdefault("fontSize", round(W * 0.03, 1))
                new.setdefault("fontWeight", 600)
                new.setdefault("fill", "navy" if design.get("background") in ("sky", "white") else "white")
                new.setdefault("align", "left")
                new.setdefault("lineHeight", 1.15)
            elif lk == "stat":
                if not (new.get("label") and new.get("value")):
                    continue
                new.setdefault("variant", "sparkline")
                new.setdefault("role", "stat")
            elif lk == "tags":
                new.setdefault("items", ["ACCOUNTING", "PAYMENTS", "PAYROLL", "ANALYTICS"])
                new.setdefault("fill", "navy" if design.get("background") in ("sky", "white") else "white")
                new.setdefault("columns", 4)
                new.setdefault("fontSize", round(W * 0.024, 1))
                new.setdefault("role", "tags")
            elif lk == "logo":
                continue  # exactly one logo; never add another
            elif lk == "button":  # a second button only when the user asks (one CTA is a soft default, not a rule)
                if not new.get("text"):
                    continue
                dark_bg = design.get("background") in ("navy", "blue")
                new.setdefault("fill", "sky" if dark_bg else "navy")
                new["textFill"] = "white" if new["fill"] == "navy" else "navy"
                new.setdefault("fontSize", round(W * 0.03, 1))
                new.setdefault("cornerRadius", round(W * 0.012, 1))
                new.setdefault("height", round(W * 0.075, 1))
                new.setdefault("role", "decor")
            elif lk == "rect":
                new.setdefault("fill", "white")
            elif lk == "bgshape":
                if not layer.get("bgId"):
                    continue
                new["bgId"] = _s(layer["bgId"])
                new.setdefault("colour", "blue")
            out: dict = {"op": "add", "layer": new}
            if isinstance(op.get("index"), int):
                out["index"] = op["index"]
            ops.append(out)
    return ops


# --------------------------------------------------------------------------------------------- agent mode
# Mirrors frontend/src/agent/types.ts. Requests are lenient (unknown fields ignored, loose values coerced in agent.py).

class PlanContext(BaseModel):
    hasDesign: bool = False
    design: Optional[dict] = None
    slots: Optional[dict] = None
    selectedRefId: Optional[str] = None
    selectedRefHeadline: Optional[str] = None
    hasUpload: bool = False
    uploadAnalysis: Optional[dict] = None
    answers: Optional[dict[str, Any]] = None
    askedAlready: bool = False


class PlanRequest(BaseModel):
    message: str = ""
    history: list[HistoryItem] = Field(default_factory=list)
    context: PlanContext = Field(default_factory=PlanContext)


class AgentQuestion(BaseModel):
    id: str
    q: str
    options: list[str]
    multi: bool = False


class PlanStep(BaseModel):
    action: Literal["edit", "resize", "fix"]
    prompt: str
    label: str


class PlanResponse(BaseModel):
    understanding: str
    action: Literal["ask", "create", "edit", "recreate", "variations", "resize", "fix", "chat", "steps"]
    questions: list[AgentQuestion] = Field(default_factory=list)
    prompt: str
    brief: Optional[str] = None
    count: int = 1
    size: Optional[Literal["4:5", "1:1", "9:16"]] = None
    steps: list[PlanStep] = Field(default_factory=list)
    reply: str = ""
    subjects: list[str] = Field(default_factory=list)
    theme: Optional[str] = None
    requirements: list[str] = Field(default_factory=list)


class CritiqueRequest(BaseModel):
    image: Optional[str] = None
    design: dict = Field(default_factory=dict)
    slots: Optional[dict] = None
    brief: Optional[str] = None
    brandIssues: list[Any] = Field(default_factory=list)
    round: int = 0
    requirements: Optional[list[Any]] = None


class CritiqueResponse(BaseModel):
    visionScore: int
    verdict: Literal["pass", "fix"]
    issues: list[str] = Field(default_factory=list)
    ops: list[dict] = Field(default_factory=list)
    briefMisses: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)
    summary: str = ""
    usedVision: bool = False
