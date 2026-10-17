#!/usr/bin/env python
"""
prep_assets.py - brand asset pipeline for the Xero Agentic Image Editor (workstream A).

Turns the raw Brand Kit (read-only, <root>/assets/Brand Kit) into clean, consistently named, pre-tinted assets
plus a manifest, all under <root>/backend/static/brand/ :

    blooms/{shape}_{colour}.png     12 shapes x 8 colours, crisp 2x upscale, tight-cropped (+4px pad)
    masks/{shape}.png               white-on-transparent alpha masks (same crop as the blooms)
    bg/bg_XX_{colour}.png           18 background templates x 4 core colours, full frame, 2x crisp
                                    (all 4 frame edges repaired, tiny uncovered specks at the frame edge filled)
    logo/logo_{navy,sky,white}.png  hi-res wordmark extracted from the 3840x2160 brand-guideline slide, + logo_mask.png
    charms/{type}_{colour}.png      65 charm types x 5 colours, cut from the 2205x4466 sheet, then 2x upscaled
                                    (LANCZOS on premultiplied alpha + mild unsharp mask on the colour)
    devices/{id}.png                7 product UI images (max side 1600); cut-out edges decontaminated (no light matte)
    illus/{id}.png|.svg             11 PNG + 3 SVG illustrations
    manifest.json                   matches `Manifest` in frontend/src/types.ts
    _preview/*.png                  contact sheets for eyeballing

Idempotent (every output directory is wiped and rebuilt; sources are only ever read from assets/).
Usage (from anywhere):
    backend/.venv/Scripts/python.exe backend/scripts/prep_assets.py [--no-previews] [--cleanup]
--cleanup additionally deletes the OLD flat copies directly in backend/static/brand (bloom_*, charm_*, illus_*, logo_*,
bg_*), after proving that each one has an identical-pixel twin under assets/.
"""
from __future__ import annotations

import argparse
import colorsys
import hashlib
import json
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

Image.MAX_IMAGE_PIXELS = None  # the brand-kit sources are huge (5269x6540 etc.)

ROOT = Path(__file__).resolve().parents[2]
KIT = ROOT / "assets" / "Brand Kit"
OUT = ROOT / "backend" / "static" / "brand"
URL = "/static/brand"

# --------------------------------------------------------------------------------------------------
# Constants (verbatim from the brief / frontend/src/brand.ts)

PALETTE = {
    "navy": "#000856", "blue": "#1F65D6", "sky": "#3ECCFF", "white": "#FFFFFF",
    "mint": "#6AEAAA", "yellow": "#FDCC08", "pink": "#FF719B", "lilac": "#CF89FE",
}
CORE = ["navy", "blue", "sky", "white"]
BLOOM_COLOURS = ["navy", "blue", "sky", "white", "mint", "yellow", "pink", "lilac"]
CHARM_COLOURS = ["blue", "green", "yellow", "pink", "purple"]
LOGO_COLOURS = ["navy", "sky", "white"]

BLOOM_ORDER = ["peace", "energy", "x", "spark", "grow", "pulse", "harmony", "motion", "balance", "ease", "surge", "stride"]
PHOTO_MASKS = {"harmony", "peace", "balance", "x", "energy"}
# old flat-copy name -> official name, and the prefix of the NAVY source file in 06_Shapes_Cropping_Blooms
# (these are the pixel-identical originals of backend/static/brand/bloom_{old}_navy.png)
OLD2NEW = {"leaf": "peace", "knot": "energy", "cross": "x", "zigzag": "spark", "wedge": "grow", "bolt": "pulse",
           "drop": "harmony", "swoosh": "motion", "wave": "balance", "hook": "ease", "curl": "surge", "omega": "stride"}
BLOOM_SRC_PREFIX = {"leaf": "34_", "knot": "30_", "cross": "32_", "zigzag": "33_", "wedge": "36_", "bolt": "38_",
                    "drop": "31_", "swoosh": "35_", "wave": "40_", "hook": "37_", "curl": "39_", "omega": "41_"}

# bg_01 .. bg_18 -> originals in 24_Background_Templates (pixel-identical to the old flat bg_XX.png)
BG_SRC_PREFIX = ["01_4c697152", "02_fb7d193a", "03_040d2847", "04_4bd578f8", "05_85cd075f", "06_86d7d942",
                 "07_91655fef", "08_e6d88a0d", "09_74b0caa7", "10_c6a417a4", "11_54fded8e", "12_caec33cd",
                 "13_f20c4a23", "14_0c91ce36", "14_996f1c06", "14_c84e0a5e", "15_17ae0d0c", "16_fe4ed594"]

LOGO_SLIDE = KIT / "05_Logo_Guidelines" / "01_xero_wordmark_primary.png"
LOGO_SLIDE_BOX = (2200, 880, 3220, 1280)  # generous box around the wordmark (wordmark ~ x2325-3095, y970-1190)
LOGO_OLD_NAVY_PREFIX = "02_"  # 10_Logo/02_* == old backend/static/brand/logo_navy.png (210x60)

CHARM_SHEET = KIT / "22_Charms" / "08_0dad3276-a933-47e9-9154-8958bc31193d.png"
# Charm type names, in sheet order (6 bands of columns, left to right). Named by looking at every column.
CHARM_NAMES = [
    # band 1
    "check", "thumbs", "sparkle", "paper", "lock", "pie", "bars", "plane", "coin_wave", "coin", "money",
    # band 2
    "percent", "mug", "point", "gauge", "battery", "link", "link_broken", "bell", "flame", "chat", "heart",
    # band 3
    "hourglass", "stopwatch", "bulb", "cocktail", "coconut", "deckchair", "coins_percent", "tax", "clock", "clock_melt", "calendar",
    # band 4
    "calendar_x", "clipboard", "phone", "laptop", "phone_bell", "phone_card", "badge", "card", "stones", "stamp", "keys",
    # band 5
    "keyring", "magnifier", "trophy", "folder", "sticky_note", "wallet", "stamp_doc", "mailbox", "magnet", "sold", "planet",
    # band 6
    "inbox", "parachute", "drum", "globe", "camera", "gift", "checkbox", "shield", "bank", "package",
]
CHARM_REQUIRED = ("sparkle heart check checkbox hourglass percent coin money mug gift bulb pie bars chat plane thumbs "
                  "calendar bell clock shield trophy lock magnifier card bank globe folder laptop phone").split()
# hue (degrees) of each variant colour on the sheet
CHARM_HUES = {"blue": 197, "green": 150, "yellow": 46, "pink": 344, "purple": 276}
CHARM_PAD = 4  # transparent px around each charm at sheet resolution (becomes CHARM_PAD * CHARM_SCALE in the output)
CHARM_SCALE = 2  # the sheet charms are only 59-129 px wide but get drawn ~120-200 px wide on a 1080 px canvas

DEVICES_DIR = "11_Product_UI_References"
DEVICES = [  # id, source prefix, tags, cutout
    ("device_tablet_kitchen", "01_b00ba535", ["tablet", "kitchen", "hands", "dashboard", "photo"], False),
    ("device_phone_hand_payments", "02_5edf1028", ["phone", "hand", "payments"], True),
    ("device_phone_hand_balance", "05_302252d6", ["phone", "hand", "balance"], True),
    ("device_laptop_overview", "03_50b369e5", ["laptop", "hands", "overview"], True),
    ("device_laptop_welcome", "04_6c44d039", ["laptop", "hands", "welcome"], True),
    ("device_tablet_hands_account", "04_bb02ae0d", ["tablet", "hands", "account"], True),
    ("device_tablet_hands_payments", "06_ca462775", ["tablet", "hands", "payments"], True),
]
DEVICE_MAX_SIDE = 1600

ILLUS_DIR = "07_Illustration"
ILLUS_PNG = [  # id (= old flat file name), source prefix, tags
    ("illus_infinity_phone_blue", "11_a3b885b9", ["phone", "mobile", "bell", "check"]),
    ("illus_infinity_phone_sky", "08_04ca290b", ["phone", "mobile", "bell", "check"]),
    ("illus_loop_bell_blue", "12_c2047bf4", ["bell", "clock", "reminder"]),
    ("illus_loop_bell_sky", "10_d253b4ba", ["bell", "clock", "reminder"]),
    ("illus_loop_coins_blue", "15_eab8740c", ["coins", "money", "wallet", "chart"]),
    ("illus_loop_coins_sky", "06_7dcd5cfc", ["coins", "money", "wallet", "chart"]),
    ("illus_wave_bulb_blue", "13_6b6de390", ["bulb", "idea", "gauge", "chart"]),
    ("illus_wave_bulb_sky", "09_699f7f9f", ["bulb", "idea", "gauge", "chart"]),
    ("illus_wave_coin_blue", "14_80d946dc", ["coin", "money", "folder"]),
    ("illus_wave_coin_sky", "07_c4828698", ["coin", "money", "folder"]),
    ("illus_wave_invoice_blue", "16_a34a5d04", ["invoice", "document", "stamp", "percent", "calendar"]),
]
ILLUS_SVG = [  # id, filename suffix, ribbon, tags
    ("illus_vacation", "Vacation.svg", "pink", ["vacation", "holiday", "deckchair", "calendar", "plane", "travel"]),
    ("illus_tax_return", "Tax_Return.svg", "sky", ["tax", "coins", "percent", "calendar", "bell", "heart"]),
    ("illus_anywhere_access", "Anywhere_Access.svg", "pink", ["anywhere", "phone", "bell", "link", "globe"]),
]


# --------------------------------------------------------------------------------------------------
# Small helpers

def log(*a):
    print(*a, flush=True)


def hex_rgb(h: str) -> tuple[int, int, int]:
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def url(*parts: str) -> str:
    return URL + "/" + "/".join(parts)


def find_one(folder: str, prefix: str) -> Path:
    hits = sorted((KIT / folder).glob(prefix + "*"))
    if len(hits) != 1:
        raise SystemExit(f"expected exactly one file matching {folder}/{prefix}*, found {len(hits)}")
    return hits[0]


def reset_dirs(*names: str) -> None:
    for n in names:
        d = OUT / n
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)


def save_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, format="PNG")


def crisp(alpha: Image.Image, scale: int = 2) -> Image.Image:
    """Crisp upscale of an 'L' alpha: LANCZOS resize, then remap v<64 -> 0, v>192 -> 255, linear in between."""
    big = alpha.resize((alpha.width * scale, alpha.height * scale), Image.LANCZOS)
    v = np.asarray(big, dtype=np.float32)
    v = np.clip((v - 64.0) * (255.0 / 128.0), 0.0, 255.0)
    return Image.fromarray(np.rint(v).astype(np.uint8), "L")


def crop_pad(alpha: Image.Image, pad: int) -> Image.Image:
    """Tight-crop an 'L' alpha to its non-zero bbox and add `pad` transparent pixels on every side."""
    bbox = alpha.getbbox()
    if bbox is None:
        raise SystemExit("empty alpha, cannot crop")
    c = alpha.crop(bbox)
    out = Image.new("L", (c.width + 2 * pad, c.height + 2 * pad), 0)
    out.paste(c, (pad, pad))
    return out


def tint(alpha: Image.Image, rgb: tuple[int, int, int]) -> Image.Image:
    im = Image.new("RGBA", alpha.size, rgb + (255,))
    im.putalpha(alpha)
    return im


def repair_last_row_col(arr: np.ndarray) -> np.ndarray:
    """The Figma exports leave the LAST row/column of a few sources semi-transparent (fractional frame size), which would
    show up as a faint seam where a shape bleeds off the frame. Replicate the previous column/row onto them."""
    arr = arr.copy()
    arr[:, -1] = arr[:, -2]
    arr[-1, :] = arr[-2, :]
    return arr


def repair_frame_edges(arr: np.ndarray) -> np.ndarray:
    """repair_last_row_col() plus the same for the FIRST row/column (backgrounds only). Template 10's export puts the
    shape edge ~0.6 px inside the LEFT frame edge (column 0 is a ~37% blend over the bottom ~10% of the height), which
    showed as a 2 px line of the canvas colour along the left edge of every bg_10 output. On the other templates this
    only moves the 1 px anti-aliasing where a shape boundary crosses the frame edge."""
    arr = repair_last_row_col(arr)
    arr[:, 0] = arr[:, 1]
    arr[0, :] = arr[1, :]
    return arr


def _dilate(mask: np.ndarray) -> np.ndarray:
    """3x3 binary dilation of a bool HxW mask (pixels outside the image count as False)."""
    h, w = mask.shape
    p = np.pad(mask, 1)
    out = np.zeros_like(mask)
    for dy in range(3):
        for dx in range(3):
            out |= p[dy:dy + h, dx:dx + w]
    return out


def _components(mask: np.ndarray) -> tuple[list[tuple[int, int, int]], list[int]]:
    """8-connected components of a bool mask, via row runs + union-find (fast enough without scipy).
    Returns the runs as (row, x0, x1) and, per run, the id of its component."""
    parent: list[int] = []

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    runs: list[tuple[int, int, int]] = []
    prev: list[tuple[int, int, int]] = []
    for y in range(mask.shape[0]):
        d = np.diff(np.concatenate(([0], mask[y].astype(np.int8), [0])))
        cur = []
        for s, e in zip(np.nonzero(d == 1)[0].tolist(), (np.nonzero(d == -1)[0] - 1).tolist()):
            k = len(runs)
            runs.append((y, s, e))
            parent.append(k)
            for ps, pe, pk in prev:
                if ps <= e + 1 and pe >= s - 1:  # overlaps or touches diagonally
                    ra, rb = find(k), find(pk)
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
            cur.append((s, e, k))
        prev = cur
    return runs, [find(i) for i in range(len(runs))]


def fill_border_islands(t: np.ndarray, max_frac: float = 0.001) -> int:
    """Shape coverage t (float HxW, modified in place): fill tiny uncovered islands (t < 0.5, < max_frac of the frame)
    that touch the frame edge, plus their 1 px anti-aliased rim. bg_11's shape stops just short of the bottom-left
    frame corner, which showed as a small triangle of the canvas colour in that corner. Returns the island size in px."""
    h, w = t.shape
    runs, comp = _components(t < 0.5)
    area: dict[int, int] = {}
    touches: dict[int, bool] = {}
    for (y, s, e), c in zip(runs, comp):
        area[c] = area.get(c, 0) + e - s + 1
        touches[c] = touches.get(c, False) or y in (0, h - 1) or s == 0 or e == w - 1
    small = {c for c in area if touches[c] and area[c] < max_frac * h * w}
    island = np.zeros((h, w), bool)
    for (y, s, e), c in zip(runs, comp):
        if c in small:
            island[y, s:e + 1] = True
    if island.any():  # the 8-neighbour ring of an island is all t >= 0.5 (else it would be part of the island)
        t[_dilate(island)] = 1.0
    return int(island.sum())


def bleed_colour(rgba: np.ndarray, known: np.ndarray, passes: int, must: np.ndarray | None = None) -> np.ndarray:
    """Grow colour outward from the `known` pixels, in place on rgba[..., :3] (uint8 HxWx4; alpha is not touched).
    Each pass gives every pixel next to the known area the mean colour of its known 3x3 neighbours (pixels outside the
    image count as unknown, so nothing wraps around). Runs `passes` passes, then more (max 8 in all) while any `must`
    pixel is still unknown. Works on index lists, so it stays cheap on the 5269x6540 device sources. Returns `known`."""
    h, w = known.shape
    known = known.copy()
    rgb = rgba[..., :3]
    for i in range(8):
        if i >= passes and (must is None or not (must & ~known).any()):
            break
        ys, xs = np.nonzero(_dilate(known) & ~known)
        if len(ys) == 0:
            break
        num = np.zeros((len(ys), 3), np.float64)
        den = np.zeros(len(ys), np.float64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yy, xx = ys + dy, xs + dx
                inside = (yy >= 0) & (yy < h) & (xx >= 0) & (xx < w)
                yy, xx = np.clip(yy, 0, h - 1), np.clip(xx, 0, w - 1)
                k = inside & known[yy, xx]
                num += rgb[yy, xx].astype(np.float64) * k[:, None]
                den += k
        rgb[ys, xs] = np.rint(num / den[:, None]).astype(np.uint8)  # den >= 1: each of these has a known neighbour
        known[ys, xs] = True
    return known


def upscale_rgba(im: Image.Image, scale: int) -> Image.Image:
    """Upscale RGBA art without dark fringes or halos: LANCZOS on premultiplied float colour, un-premultiply, bleed the
    colour 4 px into the transparent area (so the sharpening has no black to push against), then a mild UnsharpMask on
    the colour only. Alpha is the LANCZOS result minus its ringing. Fully transparent pixels come out as (0, 0, 0, 0)."""
    src = np.asarray(im.convert("RGBA"), dtype=np.float32)
    size = (im.width * scale, im.height * scale)

    def resize(ch: np.ndarray) -> np.ndarray:
        return np.asarray(Image.fromarray(np.ascontiguousarray(ch, dtype=np.float32)).resize(size, Image.LANCZOS))

    alpha = np.clip(resize(src[..., 3]), 0.0, 255.0)
    prem = np.stack([resize(src[..., c] * (src[..., 3] / 255.0)) for c in range(3)], axis=-1)
    prem = np.clip(prem, 0.0, alpha[..., None])  # premultiplied colour can never exceed alpha (LANCZOS rings)
    rgb = prem * 255.0 / np.maximum(alpha, 1e-3)[..., None]
    a8 = np.rint(alpha).astype(np.uint8)
    # LANCZOS rings: alpha dips to ~242 inside solid areas and leaves an alpha <= 15 halo ~2 px outside the art. Pin
    # pixels whose 3x3 SOURCE neighbourhood is uniformly solid / empty back to 255 / 0 (the edge band is untouched).
    a8[(~_dilate(src[..., 3] != 255)).repeat(scale, 0).repeat(scale, 1)] = 255
    a8[(~_dilate(src[..., 3] != 0)).repeat(scale, 0).repeat(scale, 1)] = 0
    out = np.dstack([np.rint(np.clip(rgb, 0.0, 255.0)).astype(np.uint8), a8])
    bleed_colour(out, a8 > 0, passes=4)
    sharp = Image.fromarray(np.ascontiguousarray(out[..., :3]), "RGB").filter(
        ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
    out = np.dstack([np.asarray(sharp), a8])
    out[a8 == 0, :3] = 0
    return Image.fromarray(out, "RGBA")


def defringe(im: Image.Image, solid: int = 250) -> Image.Image:
    """Decontaminate the soft edge of a photo cut-out (alpha unchanged). The Brand Kit cut-outs keep the light photo
    background in their semi-transparent edge pixels (edge luminance +59..+110 above the solid body next to it), which
    draws a light rim on dark colourways. Every semi-transparent pixel, and every transparent pixel within 3 px of the
    body, gets the mean colour of the solid pixels next to it, grown outward pass by pass. Other transparent pixels get
    RGB 0 (some sources keep the light-grey photo background there)."""
    a = np.array(im.convert("RGBA"))
    al = a[..., 3]
    known = bleed_colour(a, al >= solid, passes=3, must=al > 0)
    a[(al == 0) & ~known, :3] = 0
    return Image.fromarray(a, "RGBA")


# --------------------------------------------------------------------------------------------------
# 1. Blooms + masks

def build_blooms(manifest: dict) -> None:
    log("[blooms] ...")
    reset_dirs("blooms", "masks")
    by_new = {}
    for old, new in OLD2NEW.items():
        src = find_one("06_Shapes_Cropping_Blooms", BLOOM_SRC_PREFIX[old])
        alpha = Image.open(src).convert("RGBA").getchannel("A")
        alpha = crop_pad(crisp(alpha, 2), 4)
        save_png(tint(alpha, (255, 255, 255)), OUT / "masks" / f"{new}.png")
        colours = {}
        for c in BLOOM_COLOURS:
            save_png(tint(alpha, hex_rgb(PALETTE[c])), OUT / "blooms" / f"{new}_{c}.png")
            colours[c] = url("blooms", f"{new}_{c}.png")
        by_new[new] = {"shape": new, "w": alpha.width, "h": alpha.height, "photoMask": new in PHOTO_MASKS,
                       "mask": url("masks", f"{new}.png"), "colours": colours}
    manifest["blooms"] = [by_new[s] for s in BLOOM_ORDER]


# --------------------------------------------------------------------------------------------------
# 2. Background templates

def build_backgrounds(manifest: dict) -> None:
    log("[bg] ...")
    reset_dirs("bg")
    out = []
    for i, prefix in enumerate(BG_SRC_PREFIX, start=1):
        bg_id = f"bg_{i:02d}"
        src = find_one("24_Background_Templates", prefix)
        arr = np.asarray(Image.open(src).convert("RGBA"), dtype=np.float32)
        arr = repair_frame_edges(arr)
        a = arr[..., 3:4] / 255.0
        comp = arr[..., :3] * a + 255.0 * (1.0 - a)  # composite on white
        t = np.clip((255.0 - comp[..., 0]) / 224.0, 0.0, 1.0)  # shape coverage (the shape is #1F65D6, R = 31)
        filled = fill_border_islands(t)
        if filled:
            log(f"  {bg_id}: filled a {filled} px uncovered speck at the frame edge")
        alpha = crisp(Image.fromarray(np.rint(t * 255).astype(np.uint8), "L"), 2)  # FULL frame, no crop
        colours = {}
        for c in CORE:
            save_png(tint(alpha, hex_rgb(PALETTE[c])), OUT / "bg" / f"{bg_id}_{c}.png")
            colours[c] = url("bg", f"{bg_id}_{c}.png")
        out.append({"id": bg_id, "aspect": "1:1" if alpha.width == alpha.height else "9:16",
                    "w": alpha.width, "h": alpha.height, "colours": colours})
    manifest["backgrounds"] = out


# --------------------------------------------------------------------------------------------------
# 3. Logo

def iou_vs_old_logo(alpha_hi: Image.Image) -> float:
    old = Image.open(find_one("10_Logo", LOGO_OLD_NAVY_PREFIX)).convert("RGBA").getchannel("A")
    mine = alpha_hi.resize(old.size, Image.LANCZOS)
    a = np.asarray(mine) > 127
    b = np.asarray(old) > 127
    return float((a & b).sum() / max(1, (a | b).sum()))


def build_logo(manifest: dict) -> float:
    log("[logo] ...")
    reset_dirs("logo")
    slide = Image.open(LOGO_SLIDE).convert("RGB").crop(LOGO_SLIDE_BOX)
    lum = np.asarray(slide.convert("L"), dtype=np.float32)
    a = np.clip((120.0 - lum) / 80.0, 0.0, 1.0)  # alpha 1 at L<=40, 0 at L>=120
    alpha = crop_pad(Image.fromarray(np.rint(a * 255).astype(np.uint8), "L"), 0)
    iou = iou_vs_old_logo(alpha)
    method = "extracted from 01_xero_wordmark_primary.png"
    if iou <= 0.9:  # extraction failed -> fall back to the 4x crisp upscale of the 210x60 navy logo
        log(f"  extraction IoU {iou:.3f} <= 0.9, falling back to 4x crisp upscale of the 210x60 logo")
        old = Image.open(find_one("10_Logo", LOGO_OLD_NAVY_PREFIX)).convert("RGBA").getchannel("A")
        alpha = crop_pad(crisp(old, 4), 0)
        iou = iou_vs_old_logo(alpha)
        method = "fallback: 4x crisp upscale of 210x60 logo"
    save_png(tint(alpha, (255, 255, 255)), OUT / "logo" / "logo_mask.png")
    for c in LOGO_COLOURS:
        save_png(tint(alpha, hex_rgb(PALETTE[c])), OUT / "logo" / f"logo_{c}.png")
    manifest["logo"] = {"mask": url("logo", "logo_mask.png"), "navy": url("logo", "logo_navy.png"),
                        "sky": url("logo", "logo_sky.png"), "white": url("logo", "logo_white.png"),
                        "w": alpha.width, "h": alpha.height}
    log(f"  {alpha.width}x{alpha.height} ({alpha.width / alpha.height:.3f}:1), IoU vs 210x60 logo = {iou:.4f} [{method}]")
    return iou


# --------------------------------------------------------------------------------------------------
# 4. Charms (cut from the sheet)

def _near(arr, rgb, tol, amin=10):
    r, g, b, al = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    return ((np.abs(r - rgb[0]) <= tol) & (np.abs(g - rgb[1]) <= tol) & (np.abs(b - rgb[2]) <= tol) & (al >= amin))


def _runs(idx, max_gap):
    runs = []
    for i in idx:
        if runs and i - runs[-1][1] <= max_gap:
            runs[-1][1] = int(i)
        else:
            runs.append([int(i), int(i)])
    return runs


def find_frames(a: np.ndarray) -> list[dict]:
    """Locate the dashed Figma frames (purple #8A38F5/#9747FF dashes; one frame is drawn in yellow).
    Frames are top-aligned inside each band, so band tops come from a row projection of the frame colour."""
    h = a.shape[0]
    a = a.astype(np.int16)  # signed: uint8 arithmetic would wrap around in the colour comparisons below
    purple = _near(a, (138, 56, 245), 4) | _near(a, (151, 71, 255), 4)
    yellow = _near(a, (253, 204, 8), 2)
    tops = [r[0] for r in _runs(np.nonzero(purple.sum(axis=1) >= 400)[0], 1)]
    frames = []
    for bi, t in enumerate(tops):
        limit = (tops[bi + 1] - 5) if bi + 1 < len(tops) else h
        found = []
        for mask in (purple, yellow):
            row = mask[t - 1:t + 2].any(axis=0)
            for x0r, x1r in _runs(np.nonzero(row)[0], 8):
                if x1r - x0r >= 60:  # a real frame edge, not a stray charm pixel
                    found.append((x0r - 1, x1r + 1, mask))
        for x0, x1, mask in sorted(found, key=lambda f: f[0]):
            ys = np.nonzero(mask[t - 1:limit, x0:x0 + 2].any(axis=1))[0] + (t - 1)  # left edge of the frame
            yb = int(ys[0])
            for y in ys[1:]:
                if y - yb <= 8:  # dashes are 10 on / 5 off
                    yb = int(y)
                else:
                    break
            frames.append({"band": bi, "x0": int(x0), "x1": int(x1), "y0": int(t), "y1": yb})
    return frames


def split_variants(sub: np.ndarray) -> list[tuple[int, int]]:
    """Split a column interior into stacked variants by empty-row gaps (alpha projection). Tiny separate pieces
    (splash drops, sparks) are merged into the variant below them."""
    rows = np.nonzero((sub[..., 3] > 0).any(axis=1))[0]
    segs = _runs(rows, 1)
    big = max(e - s + 1 for s, e in segs)
    out, pending = [], None
    for s, e in segs:
        if e - s + 1 < 0.5 * big:
            pending = s if pending is None else pending
            continue
        out.append((pending if pending is not None else s, e))
        pending = None
    return out


def classify_hue(px: np.ndarray) -> str | None:
    px = px.reshape(-1, 4)
    px = px[px[:, 3] == 255][:, :3].astype(np.int32)
    if len(px) == 0:
        return None
    mx, mn = px.max(axis=1), px.min(axis=1)
    px = px[(mx - mn) / np.maximum(mx, 1) > 0.25]
    if len(px) == 0:
        return None
    hues = np.array([colorsys.rgb_to_hsv(*(p / 255.0))[0] * 360.0 for p in px[::5]])
    ang = np.deg2rad(hues)
    mean = float(np.rad2deg(np.arctan2(np.sin(ang).mean(), np.cos(ang).mean())) % 360.0)
    return min(CHARM_HUES, key=lambda k: min(abs(mean - CHARM_HUES[k]), 360.0 - abs(mean - CHARM_HUES[k])))


def build_charms(manifest: dict) -> dict:
    log("[charms] ...")
    reset_dirs("charms")
    a = np.asarray(Image.open(CHARM_SHEET).convert("RGBA"))
    frames = find_frames(a)
    if len(frames) != len(CHARM_NAMES):
        raise SystemExit(f"found {len(frames)} charm frames but have {len(CHARM_NAMES)} names - names out of date?")
    out, notes = [], []
    for k, fr in enumerate(frames):
        name = CHARM_NAMES[k]
        sub = a[fr["y0"] + 5:fr["y1"] - 4, fr["x0"] + 5:fr["x1"] - 4]  # interior of the frame (frame pixels excluded)
        if (sub[0, :, 3] > 0).any() or (sub[-1, :, 3] > 0).any() or (sub[:, 0, 3] > 0).any() or (sub[:, -1, 3] > 0).any():
            notes.append(f"{name}: artwork touches the frame interior border")
        segs = split_variants(sub)
        chosen: dict[str, tuple[int, int]] = {}
        for s, e in segs:
            colour = classify_hue(sub[s:e + 1])
            if colour in chosen:
                notes.append(f"{name}: dropped duplicate '{colour}' variant at rows {s}-{e}")
                continue
            chosen[colour] = (s, e)
        if sorted(chosen) != sorted(CHARM_COLOURS):
            raise SystemExit(f"{name}: expected variants {CHARM_COLOURS}, got {sorted(chosen)}")
        # one common canvas per type: x-range is the union over variants (exact), top-aligned, height = max
        x_lo, x_hi, hmax = 10 ** 9, -1, 0
        for s, e in chosen.values():
            cols = np.nonzero((sub[s:e + 1, :, 3] > 0).any(axis=0))[0]
            x_lo, x_hi, hmax = min(x_lo, int(cols[0])), max(x_hi, int(cols[-1])), max(hmax, e - s + 1)
        w, h = x_hi - x_lo + 1 + 2 * CHARM_PAD, hmax + 2 * CHARM_PAD
        colours = {}
        for colour in CHARM_COLOURS:
            s, e = chosen[colour]
            canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            canvas.paste(Image.fromarray(np.ascontiguousarray(sub[s:e + 1, x_lo:x_hi + 1]), "RGBA"), (CHARM_PAD, CHARM_PAD))
            save_png(upscale_rgba(canvas, CHARM_SCALE), OUT / "charms" / f"{name}_{colour}.png")
            colours[colour] = url("charms", f"{name}_{colour}.png")
        out.append({"type": name, "w": w * CHARM_SCALE, "h": h * CHARM_SCALE, "colours": colours})
    manifest["charms"] = out
    missing = [n for n in CHARM_REQUIRED if n not in CHARM_NAMES]
    for n in notes:
        log("  note:", n)
    return {"missing_required": missing, "notes": notes}


# --------------------------------------------------------------------------------------------------
# 5. Devices

def build_devices(manifest: dict) -> None:
    log("[devices] ...")
    reset_dirs("devices")
    out = []
    for dev_id, prefix, tags, cutout in DEVICES:
        im = Image.open(find_one(DEVICES_DIR, prefix)).convert("RGBA")
        arr = repair_last_row_col(np.asarray(im))
        im = Image.fromarray(arr, "RGBA")
        if cutout:
            al = im.getchannel("A").point(lambda v: 255 if v > 8 else 0)  # ignore faint stray pixels
            im = defringe(im.crop(al.getbbox()))  # before the resize, which would blend the matte into the rim
        else:  # a photo: flatten (it is fully opaque apart from the export seam we just repaired)
            im = Image.fromarray(arr[..., :3], "RGB")
        if max(im.size) > DEVICE_MAX_SIDE:
            s = DEVICE_MAX_SIDE / max(im.size)
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
        save_png(im, OUT / "devices" / f"{dev_id}.png")
        out.append({"id": dev_id, "src": url("devices", f"{dev_id}.png"), "w": im.width, "h": im.height,
                    "tags": tags, "cutout": cutout})
    manifest["devices"] = out


# --------------------------------------------------------------------------------------------------
# 6. Illustrations

def build_illustrations(manifest: dict) -> None:
    log("[illus] ...")
    reset_dirs("illus")
    out = []
    for ill_id, prefix, tags in ILLUS_PNG:
        src = find_one(ILLUS_DIR, prefix)
        dst = OUT / "illus" / f"{ill_id}.png"
        shutil.copyfile(src, dst)
        w, h = Image.open(dst).size
        out.append({"id": ill_id, "src": url("illus", dst.name), "w": w, "h": h, "tags": tags,
                    "ribbon": "sky" if ill_id.endswith("_sky") else "blue"})
    for ill_id, suffix, ribbon, tags in ILLUS_SVG:
        hits = sorted((KIT / ILLUS_DIR).glob("*" + suffix))
        if len(hits) != 1:
            raise SystemExit(f"expected one *{suffix} in {ILLUS_DIR}, found {len(hits)}")
        dst = OUT / "illus" / f"{ill_id}.svg"
        shutil.copyfile(hits[0], dst)
        head = dst.read_text(encoding="utf-8")[:600]
        m = re.search(r'<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"', head)
        if not m:
            raise SystemExit(f"cannot read width/height from {dst.name}")
        out.append({"id": ill_id, "src": url("illus", dst.name), "w": round(float(m.group(1))),
                    "h": round(float(m.group(2))), "tags": tags, "ribbon": ribbon})
    manifest["illustrations"] = out


# --------------------------------------------------------------------------------------------------
# 7. Manifest (+ self-check against the Manifest type in frontend/src/types.ts)

def validate_manifest(m: dict) -> None:
    def need(cond, msg):
        if not cond:
            raise SystemExit("manifest invalid: " + msg)

    need(list(m) == ["palette", "blooms", "backgrounds", "charms", "illustrations", "devices", "logo"], "top-level keys")
    need(set(m["palette"]) == set(PALETTE), "palette keys")
    paths = []
    for b in m["blooms"]:
        need(set(b) == {"shape", "w", "h", "photoMask", "mask", "colours"}, f"bloom keys {b.get('shape')}")
        need(set(b["colours"]) <= set(PALETTE) and len(b["colours"]) == 8, "bloom colours")
        paths += [b["mask"], *b["colours"].values()]
    for b in m["backgrounds"]:
        need(set(b) == {"id", "aspect", "w", "h", "colours"} and b["aspect"] in ("1:1", "9:16"), f"bg keys {b.get('id')}")
        need(set(b["colours"]) == set(CORE), "bg colours")
        paths += list(b["colours"].values())
    for c in m["charms"]:
        need(set(c) == {"type", "w", "h", "colours"} and set(c["colours"]) == set(CHARM_COLOURS), f"charm {c.get('type')}")
        paths += list(c["colours"].values())
    for i in m["illustrations"]:
        need(set(i) <= {"id", "src", "w", "h", "tags", "ribbon"} and {"id", "src", "w", "h", "tags"} <= set(i), f"illus {i.get('id')}")
        need(i.get("ribbon") in (None, "sky", "blue", "pink"), "ribbon")
        paths.append(i["src"])
    for d in m["devices"]:
        need(set(d) == {"id", "src", "w", "h", "tags", "cutout"} and isinstance(d["cutout"], bool), f"device {d.get('id')}")
        paths.append(d["src"])
    need(set(m["logo"]) == {"mask", "navy", "sky", "white", "w", "h"}, "logo keys")
    paths += [m["logo"][k] for k in ("mask", "navy", "sky", "white")]
    for p in paths:
        need(p.startswith(URL + "/"), f"url prefix {p}")
        need((OUT / p[len(URL) + 1:]).is_file(), f"missing file for {p}")


def write_manifest(manifest: dict) -> None:
    m = {"palette": PALETTE}
    for k in ("blooms", "backgrounds", "charms", "illustrations", "devices", "logo"):
        m[k] = manifest[k]
    validate_manifest(m)
    (OUT / "manifest.json").write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------------------------------
# Previews (contact sheets for eyeballing)

def _font(size=13):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


def sheet(path: Path, tiles: list[tuple[str, Image.Image]], cols: int, cell: tuple[int, int],
          bg=(150, 150, 150), label_h=16) -> None:
    cw, ch = cell
    rows = (len(tiles) + cols - 1) // cols
    canvas = Image.new("RGB", (cols * (cw + 8) + 8, rows * (ch + label_h + 8) + 8), bg)
    d = ImageDraw.Draw(canvas)
    f = _font(12)
    for i, (label, im) in enumerate(tiles):
        x, y = 8 + (i % cols) * (cw + 8), 8 + (i // cols) * (ch + label_h + 8)
        im = im.convert("RGBA")
        s = min(cw / im.width, ch / im.height)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
        tile = Image.new("RGBA", (cw, ch), bg + (255,))
        tile.alpha_composite(im, ((cw - im.width) // 2, (ch - im.height) // 2))
        canvas.paste(tile.convert("RGB"), (x, y + label_h))
        d.text((x, y), label, fill=(0, 0, 0), font=f)
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path)


def make_previews(manifest: dict) -> None:
    log("[previews] ...")
    pv = OUT / "_preview"
    if pv.exists():
        shutil.rmtree(pv)
    pv.mkdir(parents=True)

    def load(u: str) -> Image.Image:
        return Image.open(OUT / u[len(URL) + 1:]).convert("RGBA")

    # blooms: mask + 8 colours per shape on mid grey
    tiles = []
    for b in manifest["blooms"]:
        tiles.append((f"{b['shape']} mask", load(b["mask"])))
        tiles += [(f"{b['shape']} {c}", load(u)) for c, u in b["colours"].items()]
    sheet(pv / "blooms.png", tiles, cols=9, cell=(110, 80), bg=(120, 130, 145))

    # backgrounds: the combinations the templates use
    combos = [("navy", (205, 238, 255)), ("blue", (0, 8, 86)), ("sky", (31, 101, 214)), ("white", (0, 8, 86))]
    for aspect, cell in (("1:1", (120, 120)), ("9:16", (80, 142))):
        tiles = []
        for c, bgc in combos:
            for b in manifest["backgrounds"]:
                if b["aspect"] == aspect:
                    shape = load(b["colours"][c])
                    t = Image.new("RGBA", shape.size, bgc + (255,))
                    t.alpha_composite(shape)
                    tiles.append((f"{b['id']} {c}", t))
        sheet(pv / f"bg_{aspect.replace(':', 'x')}.png", tiles, cols=9, cell=cell, bg=(160, 160, 160))

    # logo
    lg = manifest["logo"]
    tiles = [("mask on grey", load(lg["mask"])), ("navy on sky", None), ("sky on navy", None), ("white on blue", None)]
    for i, (c, bgc) in enumerate((("navy", (62, 204, 255)), ("sky", (0, 8, 86)), ("white", (31, 101, 214))), start=1):
        im = load(lg[c])
        t = Image.new("RGBA", (im.width + 160, im.height + 160), bgc + (255,))
        t.alpha_composite(im, (80, 80))
        tiles[i] = (f"{c}", t)
    sheet(pv / "logo.png", tiles, cols=2, cell=(560, 240), bg=(150, 150, 150))

    # charms: one sheet per band of 11 columns, 5 stacked variants each
    per = 11
    for bi in range(0, len(manifest["charms"]), per):
        group = manifest["charms"][bi:bi + per]
        cw, ch = 130, 100
        canvas = Image.new("RGB", (len(group) * (cw + 6) + 6, 5 * (ch + 4) + 26), (170, 170, 170))
        d = ImageDraw.Draw(canvas)
        f = _font(13)
        for ci, c in enumerate(group):
            x = 6 + ci * (cw + 6)
            d.text((x, 4), c["type"], fill=(0, 0, 0), font=f)
            for vi, colour in enumerate(CHARM_COLOURS):
                im = load(c["colours"][colour])
                s = min(cw / im.width, ch / im.height, 2.0)
                im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
                tile = Image.new("RGBA", (cw, ch), (170, 170, 170, 255))
                tile.alpha_composite(im, ((cw - im.width) // 2, (ch - im.height) // 2))
                canvas.paste(tile.convert("RGB"), (x, 24 + vi * (ch + 4)))
        canvas.save(pv / f"charms_{bi // per + 1}.png")

    # devices + illustrations (PNG only; SVGs are plain copies)
    sheet(pv / "devices.png", [(d["id"], load(d["src"])) for d in manifest["devices"]], cols=4, cell=(300, 300),
          bg=(200, 200, 200))
    sheet(pv / "illus.png", [(i["id"], load(i["src"])) for i in manifest["illustrations"] if i["src"].endswith(".png")],
          cols=4, cell=(300, 220), bg=(235, 235, 235))


# --------------------------------------------------------------------------------------------------
# 8. Cleanup of the old flat copies

def _pixel_hash(path: Path) -> str:
    im = Image.open(path).convert("RGBA")
    return hashlib.md5(im.tobytes() + str(im.size).encode()).hexdigest()


def cleanup_flat() -> None:
    flat = sorted(p for pat in ("bloom_*.png", "charm_*.png", "illus_*.png", "logo_*.png", "bg_*.png") for p in OUT.glob(pat))
    if not flat:
        log("[cleanup] nothing to delete")
        return
    twins: dict[str, Path] = {}
    for p in KIT.rglob("*.png"):
        w, h = Image.open(p).size
        if w * h <= 2_000_000:
            twins.setdefault(_pixel_hash(p), p)
    lost = [p.name for p in flat if _pixel_hash(p) not in twins]
    if lost:
        raise SystemExit(f"[cleanup] refusing: no identical twin under assets/ for {lost}")
    for p in flat:
        p.unlink()
    log(f"[cleanup] deleted {len(flat)} old flat files (each has an identical-pixel twin under assets/)")


# --------------------------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-previews", action="store_true", help="skip the _preview contact sheets")
    ap.add_argument("--cleanup", action="store_true", help="delete the old flat copies in backend/static/brand")
    args = ap.parse_args()
    t0 = time.time()
    if not KIT.is_dir():
        raise SystemExit(f"brand kit not found at {KIT}")
    OUT.mkdir(parents=True, exist_ok=True)

    manifest: dict = {}
    build_blooms(manifest)
    build_backgrounds(manifest)
    iou = build_logo(manifest)
    charm_info = build_charms(manifest)
    build_devices(manifest)
    build_illustrations(manifest)
    write_manifest(manifest)
    if not args.no_previews:
        make_previews(manifest)
    if args.cleanup:
        cleanup_flat()

    log("")
    log("=== summary ===")
    log(f"blooms: {len(manifest['blooms'])} shapes x {len(BLOOM_COLOURS)} colours + {len(manifest['blooms'])} masks")
    log(f"bg: {len(manifest['backgrounds'])} templates x {len(CORE)} colours")
    log(f"logo: {manifest['logo']['w']}x{manifest['logo']['h']}, IoU vs old 210x60 = {iou:.4f}")
    log(f"charms: {len(manifest['charms'])} types x {len(CHARM_COLOURS)} colours ({CHARM_SCALE}x upscaled)")
    log(f"devices: {len(manifest['devices'])}   illustrations: {len(manifest['illustrations'])}")
    if charm_info["missing_required"]:
        log("MISSING required charm names:", charm_info["missing_required"])
    else:
        log(f"all {len(CHARM_REQUIRED)} required charm names present")
    log(f"done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
