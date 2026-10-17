"""Reference library loader (backend/data/references.json, written by the controller). Re-read on mtime change."""
from __future__ import annotations

import json
import logging
from typing import Any

from .config import REFERENCES_PATH

log = logging.getLogger("refs")
_cache: dict[str, Any] = {"mtime": None, "data": []}


def load_references() -> list[dict]:
    """Raw entries: [{id, file, slots, notes}]. Empty list if the file is missing/unreadable."""
    try:
        mtime = REFERENCES_PATH.stat().st_mtime
    except FileNotFoundError:
        return []
    if _cache["mtime"] != mtime:
        try:
            data = json.loads(REFERENCES_PATH.read_text(encoding="utf-8"))
            _cache["data"] = [r for r in data if isinstance(r, dict) and r.get("id") and isinstance(r.get("slots"), dict)]
            _cache["mtime"] = mtime
        except Exception as e:  # noqa: BLE001  (half-written file: keep the previous copy)
            log.warning("references.json unreadable (%s)", e)
    return _cache["data"]


def get_reference(ref_id: str | None) -> dict | None:
    if not ref_id:
        return None
    rid = str(ref_id).strip().lower().removeprefix("ref_").removesuffix(".png")
    for r in load_references():
        if str(r["id"]).lower() == rid or str(r.get("file", "")).lower().removesuffix(".png") in (rid, f"ref_{rid}"):
            return r
    return None


def references_api() -> list[dict]:
    """Reference[] for GET /api/references."""
    out = []
    for r in load_references():
        item = {"id": str(r["id"]), "url": f"/static/refs/{r.get('file', '')}", "slots": r["slots"]}
        if r.get("notes"):
            item["notes"] = r["notes"]
        out.append(item)
    return out
