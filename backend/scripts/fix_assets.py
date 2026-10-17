"""Post-process the brand assets written by prep_assets.py (idempotent; run after it).

1. Charms: 2x LANCZOS upscale (Pillow premultiplies RGBA internally) + mild unsharp, so the
   ~60-130 px sheet charms stay crisp when drawn at 120-260 px.
2. Device cut-outs: remove the white matte fringe inherited from the source photos by
   re-colouring semi-transparent edge pixels from their opaque neighbours (alpha unchanged).
3. Background templates: repair the semi-transparent first row/column (bg_10 left-edge seam)
   and fill bg_11's chipped bottom-left corner.

usage: backend/.venv/Scripts/python.exe backend/scripts/fix_assets.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

BRAND = Path(__file__).resolve().parents[1] / "static" / "brand"
MANIFEST = BRAND / "manifest.json"


def upscale_charms(manifest: dict) -> int:
    marker = BRAND / "charms" / ".upscaled"
    if marker.exists():
        return 0
    n = 0
    for charm in manifest["charms"]:
        for url in charm["colours"].values():
            path = BRAND / url.removeprefix("/static/brand/")
            im = Image.open(path).convert("RGBA")
            big = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
            r, g, b, a = big.split()
            rgb = Image.merge("RGB", (r, g, b)).filter(ImageFilter.UnsharpMask(radius=1.2, percent=50, threshold=2))
            Image.merge("RGBA", (*rgb.split(), a)).save(path, optimize=True)
            n += 1
        charm["w"], charm["h"] = charm["w"] * 2, charm["h"] * 2
    marker.write_text("charms upscaled 2x by fix_assets.py\n")
    return n


def defringe(path: Path, passes: int = 4) -> None:
    arr = np.asarray(Image.open(path).convert("RGBA")).astype(np.float32)
    rgb, alpha = arr[..., :3].copy(), arr[..., 3]
    known = alpha >= 250
    h, w = known.shape
    for _ in range(passes):
        k = np.pad(known.astype(np.float32), 1, mode="edge")
        kr = np.pad(rgb * known[..., None], ((1, 1), (1, 1), (0, 0)), mode="edge")
        den = sum(k[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        num = sum(kr[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        fill = ~known & (den > 0)
        rgb[fill] = num[fill] / den[fill][:, None]
        known |= fill
    out = np.concatenate([rgb, alpha[..., None]], axis=2).round().clip(0, 255).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(path, optimize=True)


def fix_devices(manifest: dict) -> int:
    marker = BRAND / "devices" / ".defringed"
    if marker.exists():
        return 0
    n = 0
    for dev in manifest["devices"]:
        if dev.get("cutout"):
            defringe(BRAND / dev["src"].removeprefix("/static/brand/"))
            n += 1
    marker.write_text("device edges defringed by fix_assets.py\n")
    return n


def fix_backgrounds() -> int:
    n = 0
    for path in sorted((BRAND / "bg").glob("bg_*.png")):
        arr = np.array(Image.open(path).convert("RGBA"))
        arr[:, 0:2, 3] = arr[:, 2:3, 3]
        arr[0:2, :, 3] = arr[2:3, :, 3]
        if path.name.startswith("bg_11_"):
            arr[-18:, :20, 3] = 255
        Image.fromarray(arr, "RGBA").save(path, optimize=True)
        n += 1
    return n


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    charms = upscale_charms(manifest)
    devices = fix_devices(manifest)
    bgs = fix_backgrounds()
    MANIFEST.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"charms upscaled: {charms}, devices defringed: {devices}, backgrounds repaired: {bgs}")


if __name__ == "__main__":
    main()
