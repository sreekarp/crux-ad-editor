"""Brand constants + the asset manifest (backend/static/brand/manifest.json, produced by workstream A).

The manifest is read lazily and re-read when its mtime changes; everything has a CONTRACT.md fallback.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from .config import MANIFEST_PATH

log = logging.getLogger("assets")

PALETTE = {
    "navy": "#000856", "blue": "#1F65D6", "sky": "#3ECCFF", "white": "#FFFFFF",
    "mint": "#6AEAAA", "yellow": "#FDCC08", "pink": "#FF719B", "lilac": "#CF89FE",
}
COLOUR_TOKENS = list(PALETTE)
CORE_COLOURS = ["navy", "blue", "sky", "white"]
CHARM_COLOURS = ["blue", "green", "yellow", "pink", "purple"]
LOGO_COLOURS = ["navy", "sky", "white"]
TEXT_COLOURS = ["navy", "white"]
TEMPLATES = ["card", "bold", "checklist", "split", "offer"]
COLOURWAYS = ["light", "dark", "blue"]
BLOOM_SHAPES = ["peace", "energy", "x", "spark", "grow", "pulse", "harmony", "motion", "balance", "ease", "surge", "stride"]
PHOTO_MASKS = ["harmony", "peace", "balance", "x", "energy"]
OLD_BLOOM_NAMES = {"leaf": "peace", "knot": "energy", "cross": "x", "zigzag": "spark", "wedge": "grow", "bolt": "pulse",
                   "drop": "harmony", "swoosh": "motion", "wave": "balance", "hook": "ease", "curl": "surge",
                   "omega": "stride"}
STAT_VARIANTS = ["sparkline", "check", "area", "bars"]
HERO_TYPES = ["photo", "device", "illustration", "none"]
CTA_STYLES = ["sky", "navy", "white"]

PHOTO_TAGS = ["florist", "cafe", "bakery", "boutique", "maker", "woodworker", "tradie", "builder", "beekeeper",
              "foodtruck", "salon", "farmer", "homeoffice", "laptop"]

REQUIRED_CHARMS = ["sparkle", "heart", "check", "checkbox", "hourglass", "percent", "coin", "money", "mug", "gift", "bulb",
                   "pie", "bars", "chat", "plane", "thumbs", "calendar", "bell", "clock", "shield", "trophy", "lock",
                   "magnifier", "card", "bank", "globe", "folder", "laptop", "phone"]

DEVICES_FALLBACK = {
    "device_tablet_kitchen": "photo of a tablet showing Xero on a kitchen counter (full photo, not a cut-out)",
    "device_phone_hand_payments": "hand holding a phone showing Xero payments (cut-out)",
    "device_phone_hand_balance": "hand holding a phone showing a Xero bank balance (cut-out)",
    "device_laptop_overview": "laptop showing the Xero business overview dashboard (cut-out)",
    "device_laptop_welcome": "laptop with the Xero welcome dashboard and typing hands (cut-out)",
    "device_tablet_hands_account": "hands holding a tablet showing a Xero account screen (cut-out)",
    "device_tablet_hands_payments": "hands holding a tablet showing Xero payments (cut-out)",
}
ILLUSTRATIONS_FALLBACK = {
    "illus_infinity_phone_blue": "infinity ribbon looping round a phone (blue ribbon)",
    "illus_infinity_phone_sky": "infinity ribbon looping round a phone (sky ribbon)",
    "illus_loop_bell_blue": "ribbon loop with a notification bell (blue)",
    "illus_loop_bell_sky": "ribbon loop with a notification bell (sky)",
    "illus_loop_coins_blue": "ribbon loop with stacked coins (blue)",
    "illus_loop_coins_sky": "ribbon loop with stacked coins (sky)",
    "illus_wave_bulb_blue": "ribbon wave with a light bulb idea (blue)",
    "illus_wave_bulb_sky": "ribbon wave with a light bulb idea (sky)",
    "illus_wave_coin_blue": "ribbon wave with a coin (blue)",
    "illus_wave_coin_sky": "ribbon wave with a coin (sky)",
    "illus_wave_invoice_blue": "ribbon wave with an invoice (blue)",
    "illus_vacation": "holiday scene: sun lounger, time off (pink/sky ribbons)",
    "illus_tax_return": "tax return documents and calculator (pink/sky ribbons)",
    "illus_anywhere_access": "laptop + phone, work from anywhere (pink ribbon)",
}

_cache: dict[str, Any] = {"mtime": None, "data": None}


def manifest() -> dict | None:
    """Current manifest dict or None (re-read when the file changes)."""
    try:
        mtime = MANIFEST_PATH.stat().st_mtime
    except FileNotFoundError:
        return None
    if _cache["mtime"] != mtime:
        try:
            _cache["data"] = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
            _cache["mtime"] = mtime
            log.info("manifest loaded: %d charms, %d devices, %d illustrations",
                     len(_cache["data"].get("charms", [])), len(_cache["data"].get("devices", [])),
                     len(_cache["data"].get("illustrations", [])))
        except Exception as e:  # noqa: BLE001  (half-written file: keep the previous copy)
            log.warning("manifest unreadable (%s); using previous/fallback", e)
    return _cache["data"]


def charm_types() -> list[str]:
    m = manifest()
    if m and m.get("charms"):
        return [c["type"] for c in m["charms"] if c.get("type")]
    return list(REQUIRED_CHARMS)


def charm_colours(charm: str) -> list[str]:
    m = manifest()
    if m and m.get("charms"):
        for c in m["charms"]:
            if c.get("type") == charm:
                cols = [k for k in (c.get("colours") or {}) if k in CHARM_COLOURS]
                return cols or list(CHARM_COLOURS)
    return list(CHARM_COLOURS)


def charm_aspect(charm: str) -> float:
    """height / width of the charm image (1.0 if unknown)."""
    m = manifest()
    for c in (m or {}).get("charms", []) or []:
        if c.get("type") == charm and c.get("w") and c.get("h"):
            return float(c["h"]) / float(c["w"])
    return 1.0


def devices() -> dict[str, str]:
    """id -> short description."""
    m = manifest()
    if m and m.get("devices"):
        out = {}
        for d in m["devices"]:
            if d.get("id"):
                desc = DEVICES_FALLBACK.get(d["id"]) or ", ".join(d.get("tags") or [])
                out[d["id"]] = desc
        return out
    return dict(DEVICES_FALLBACK)


def illustrations() -> dict[str, str]:
    m = manifest()
    if m and m.get("illustrations"):
        out = {}
        for d in m["illustrations"]:
            if d.get("id"):
                out[d["id"]] = ILLUSTRATIONS_FALLBACK.get(d["id"]) or ", ".join(d.get("tags") or [])
        return out
    return dict(ILLUSTRATIONS_FALLBACK)


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def nearest_token(rgb: tuple[int, int, int] | str, allowed: list[str] | None = None) -> str:
    if isinstance(rgb, str):
        rgb = _hex_to_rgb(rgb)
    allowed = allowed or COLOUR_TOKENS
    best, bd = allowed[0], 1e18
    for t in allowed:
        r, g, b = _hex_to_rgb(PALETTE[t])
        # weighted RGB distance (cheap perceptual approximation)
        d = 2 * (r - rgb[0]) ** 2 + 4 * (g - rgb[1]) ** 2 + 3 * (b - rgb[2]) ** 2
        if d < bd:
            best, bd = t, d
    return best
