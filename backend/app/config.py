"""Settings, paths and the three AsyncOpenAI clients (DeepSeek pro, DeepSeek flash, OpenAI images).

Keys come from <project root>/.env and are never logged or returned by any endpoint.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from dotenv import load_dotenv
from openai import AsyncOpenAI

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent
load_dotenv(ROOT_DIR / ".env")

STATIC_DIR = BACKEND_DIR / "static"
BRAND_DIR = STATIC_DIR / "brand"
MANIFEST_PATH = BRAND_DIR / "manifest.json"
REFS_DIR = STATIC_DIR / "refs"
GEN_DIR = STATIC_DIR / "gen"
BANK_DIR = GEN_DIR / "bank"
BANK_JSON = BANK_DIR / "bank.json"
UPLOADS_DIR = STATIC_DIR / "uploads"
DATA_DIR = BACKEND_DIR / "data"
REFERENCES_PATH = DATA_DIR / "references.json"

for _d in (GEN_DIR, BANK_DIR, UPLOADS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
for _noisy in ("httpx", "httpx2", "openai"):  # these log request URLs (endpoint hosts) at INFO
    logging.getLogger(_noisy).setLevel(logging.WARNING)


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip().strip('"').strip("'")


class Settings:
    pro_key = _env("DEEPSEEK_PRO_KEY")
    pro_base_url = _env("DEEPSEEK_PRO_BASE_URL")
    pro_model = _env("DEEPSEEK_PRO_MODEL", "DeepSeek-V4-Pro")
    flash_key = _env("DEEPSEEK_FLASH_KEY")
    flash_base_url = _env("DEEPSEEK_FLASH_BASE_URL")
    flash_model = _env("DEEPSEEK_FLASH_MODEL", "DeepSeek-V4.1-Flash")
    openai_key = _env("OPENAI_API_KEY")
    image_model = _env("IMAGE_MODEL", "gpt-image-2.5-flare")

    # seconds
    pro_timeout = float(_env("PRO_TIMEOUT", "120"))
    flash_timeout = float(_env("FLASH_TIMEOUT", "60"))
    image_timeout = float(_env("IMAGE_TIMEOUT", "200"))


settings = Settings()


def _make_chat_client(key: str, base_url: str, timeout: float) -> AsyncOpenAI:
    """OpenAI-compatible client. Handles Azure-style URLs (query string -> default_query, api-key header)."""
    kwargs: dict = {"api_key": key or "missing-key", "timeout": timeout, "max_retries": 0}
    if base_url:
        parts = urlsplit(base_url)
        path = parts.path.rstrip("/")
        if path.endswith("/chat/completions"):
            path = path[: -len("/chat/completions")]
        kwargs["base_url"] = urlunsplit((parts.scheme, parts.netloc, path, "", ""))
        query = dict(parse_qsl(parts.query))
        if query:
            kwargs["default_query"] = query
        if "azure" in parts.netloc.lower() and key:
            kwargs["default_headers"] = {"api-key": key}
    return AsyncOpenAI(**kwargs)


pro_client = _make_chat_client(settings.pro_key, settings.pro_base_url, settings.pro_timeout)
flash_client = _make_chat_client(settings.flash_key, settings.flash_base_url, settings.flash_timeout)
openai_client = AsyncOpenAI(api_key=settings.openai_key or "missing-key", timeout=settings.image_timeout, max_retries=1)

CHAT = {
    "pro": (pro_client, settings.pro_model, settings.pro_timeout),
    "flash": (flash_client, settings.flash_model, settings.flash_timeout),
}


def keys_present() -> dict:
    return {"pro": bool(settings.pro_key), "flash": bool(settings.flash_key), "openai": bool(settings.openai_key)}
