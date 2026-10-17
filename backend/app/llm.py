"""chat_json: DeepSeek chat -> dict, with JSON-mode detection, retries, backoff and tier fallback."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from typing import Any

import openai

from .config import CHAT

log = logging.getLogger("llm")

Tier = str  # 'pro' | 'flash'

# Per-tier capability memory, learned from the endpoint's 400s.
_caps: dict[str, dict[str, Any]] = {
    "pro": {"json_mode": True, "temperature": True, "max_tokens_key": "max_tokens"},
    "flash": {"json_mode": True, "temperature": True, "max_tokens_key": "max_tokens"},
}
# Last-call stats for /api/health and the report.
stats: dict[str, dict[str, Any]] = {"pro": {}, "flash": {}}


class LLMError(Exception):
    pass


class BadJSON(LLMError):
    def __init__(self, msg: str, text: str):
        super().__init__(msg)
        self.text = text


def other(tier: Tier) -> Tier:
    return "flash" if tier == "pro" else "pro"


def json_mode_supported(tier: Tier) -> bool:
    return bool(_caps[tier]["json_mode"])


# --------------------------------------------------------------------------------------------- parsing

_THINK_RE = re.compile(r"<think>.*?</think>", re.S | re.I)


def _strip_reasoning(text: str) -> str:
    text = _THINK_RE.sub("", text)
    if "</think>" in text:  # opening tag lost; keep only what follows the reasoning
        text = text.split("</think>", 1)[1]
    return text


def extract_json(text: str) -> dict:
    """First balanced {...} that parses as a JSON object (strings/escapes respected)."""
    if not text:
        raise ValueError("empty response")
    text = _strip_reasoning(text).strip()
    # Whole thing (possibly fenced) first.
    fenced = re.findall(r"```(?:json)?\s*(.*?)```", text, re.S | re.I)
    for cand in fenced + [text]:
        try:
            obj = json.loads(cand.strip())
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    n = len(text)
    start = text.find("{")
    while 0 <= start < n:
        depth, in_str, esc = 0, False, False
        for i in range(start, n):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    cand = text[start : i + 1]
                    try:
                        obj = json.loads(cand)
                        if isinstance(obj, dict):
                            return obj
                    except Exception:
                        try:  # tolerate trailing commas
                            obj = json.loads(re.sub(r",\s*([}\]])", r"\1", cand))
                            if isinstance(obj, dict):
                                return obj
                        except Exception:
                            pass
                    break
        start = text.find("{", start + 1)
    raise ValueError("no JSON object found in model output")


# --------------------------------------------------------------------------------------------- calls

def _status(e: Exception) -> int | None:
    return getattr(e, "status_code", None)


def _retryable(e: Exception) -> bool:
    if isinstance(e, (openai.APITimeoutError, openai.APIConnectionError, asyncio.TimeoutError)):
        return True
    s = _status(e)
    return s is not None and (s == 429 or s == 408 or s >= 500)


def _retry_after(e: Exception) -> float | None:
    try:
        resp = getattr(e, "response", None)
        if resp is not None:
            v = resp.headers.get("retry-after")
            if v:
                return min(float(v), 20.0)
    except Exception:
        pass
    return None


async def _once(messages: list[dict], tier: Tier, timeout: float | None, max_tokens: int,
                temperature: float | None) -> tuple[str, dict]:
    client, model, default_timeout = CHAT[tier]
    caps = _caps[tier]
    kwargs: dict[str, Any] = {"model": model, "messages": messages, "timeout": timeout or default_timeout}
    kwargs[caps["max_tokens_key"]] = max_tokens
    if caps["json_mode"]:
        kwargs["response_format"] = {"type": "json_object"}
    if temperature is not None and caps["temperature"]:
        kwargs["temperature"] = temperature
    t0 = time.perf_counter()
    resp = await client.chat.completions.create(**kwargs)
    ms = int((time.perf_counter() - t0) * 1000)
    msg = resp.choices[0].message
    text = msg.content or ""
    if not text.strip():
        text = getattr(msg, "reasoning_content", None) or ""
    usage = getattr(resp, "usage", None)
    info = {
        "ms": ms, "model": model, "json_mode": caps["json_mode"],
        "prompt_tokens": getattr(usage, "prompt_tokens", None),
        "completion_tokens": getattr(usage, "completion_tokens", None),
        "finish": resp.choices[0].finish_reason,
    }
    log.info("llm tier=%s model=%s ms=%d json_mode=%s tokens=%s/%s finish=%s", tier, model, ms, caps["json_mode"],
             info["prompt_tokens"], info["completion_tokens"], info["finish"])
    stats[tier] = info
    return text, info


def _adapt_to_400(e: Exception, tier: Tier) -> bool:
    """Learn from a 400. Returns True if a parameter was dropped and the call should be retried."""
    caps = _caps[tier]
    msg = str(e).lower()
    if "image" in msg or "content type" in msg or "context length" in msg or "maximum context" in msg:
        return False  # not a parameter problem (e.g. text-only model got an image)
    if any(k in msg for k in ("content_filter", "content management", "jailbreak", "responsibleai", "content filter")):
        return False  # provider safety filter on this prompt: not a parameter problem, keep JSON mode on
    if caps["json_mode"] and ("response_format" in msg or "json" in msg):
        caps["json_mode"] = False
        log.warning("tier=%s: JSON mode rejected -> falling back to text extraction", tier)
        return True
    if caps["temperature"] and "temperature" in msg:
        caps["temperature"] = False
        return True
    if caps["max_tokens_key"] == "max_tokens" and "max_tokens" in msg:
        caps["max_tokens_key"] = "max_completion_tokens"
        return True
    if caps["json_mode"]:  # unknown 400 with JSON mode on: assume JSON mode is the culprit, once
        caps["json_mode"] = False
        log.warning("tier=%s: unexplained 400 with JSON mode -> disabling JSON mode (%s)", tier, msg[:200])
        return True
    return False


def _left(deadline: float | None) -> float | None:
    """Seconds until `deadline` (a time.perf_counter() value); raises once there is no useful time left."""
    if deadline is None:
        return None
    left = deadline - time.perf_counter()
    if left < 3:
        raise LLMError("time budget exhausted")
    return left


async def _call_tier(messages: list[dict], tier: Tier, timeout: float | None, max_tokens: int,
                     temperature: float | None, tries: int = 4, deadline: float | None = None) -> dict:
    attempt = 0
    adapts = 0
    while True:
        left = _left(deadline)
        call_timeout = min(timeout or CHAT[tier][2], left) if left is not None else timeout
        try:
            text, _info = await _once(messages, tier, call_timeout, max_tokens, temperature)
        except openai.BadRequestError as e:
            if adapts < 3 and _adapt_to_400(e, tier):
                adapts += 1
                continue
            raise
        except Exception as e:  # noqa: BLE001
            attempt += 1
            # A tier that hangs rarely recovers on the 3rd/4th wait: give the other tier its turn sooner.
            limit = min(tries, 2) if isinstance(e, (openai.APITimeoutError, asyncio.TimeoutError)) else tries
            if attempt >= limit or not _retryable(e):
                raise
            delay = _retry_after(e) or min(16.0, 1.0 * (2 ** (attempt - 1))) + random.uniform(0, 0.8)
            if deadline is not None and time.perf_counter() + delay > deadline - 3:
                raise
            log.warning("tier=%s attempt %d failed (%s: %s); retrying in %.1fs", tier, attempt, type(e).__name__,
                        _status(e), delay)
            await asyncio.sleep(delay)
            continue
        try:
            return extract_json(text)
        except ValueError as e:
            raise BadJSON(str(e), text) from e


async def chat_json(messages: list[dict], tier: Tier = "flash", timeout: float | None = None,
                    max_tokens: int = 4000, temperature: float | None = None, fallback: bool = True,
                    deadline: float | None = None) -> dict:
    """Chat completion parsed as a JSON object. Retries transient errors, then tries the other tier once.
    `deadline` (a time.perf_counter() value): retries, fallback and the calls themselves all stop before it and raise
    LLMError, so the endpoint can still answer before the browser's own timeout gives up on it."""
    left = _left(deadline)
    if left is None:
        return await _chat_json(messages, tier, timeout, max_tokens, temperature, fallback, None)
    try:
        return await asyncio.wait_for(_chat_json(messages, tier, timeout, max_tokens, temperature, fallback, deadline),
                                      timeout=left)
    except asyncio.TimeoutError as e:
        raise LLMError(f"timed out after {left:.0f}s") from e


async def _chat_json(messages: list[dict], tier: Tier, timeout: float | None, max_tokens: int,
                     temperature: float | None, fallback: bool, deadline: float | None) -> dict:
    try:
        return await _call_tier(messages, tier, timeout, max_tokens, temperature, deadline=deadline)
    except BadJSON:
        raise
    except Exception as e:  # noqa: BLE001
        if not fallback:
            raise LLMError(f"{tier}: {type(e).__name__}: {e}") from e
        log.warning("tier=%s failed (%s: %s); falling back to %s", tier, type(e).__name__, str(e)[:200], other(tier))
        try:
            return await _call_tier(messages, other(tier), timeout, max_tokens, temperature, tries=2, deadline=deadline)
        except BadJSON:
            raise
        except Exception as e2:  # noqa: BLE001
            raise LLMError(f"{tier}: {type(e).__name__}: {str(e)[:200]} | {other(tier)}: "
                           f"{type(e2).__name__}: {str(e2)[:200]}") from e2


async def chat_text(messages: list[dict], tier: Tier = "flash", timeout: float | None = None,
                    max_tokens: int = 300) -> tuple[str, dict]:
    """Plain completion without JSON mode (used by the smoke test)."""
    client, model, default_timeout = CHAT[tier]
    caps = _caps[tier]
    t0 = time.perf_counter()
    resp = await client.chat.completions.create(model=model, messages=messages, timeout=timeout or default_timeout,
                                                **{caps["max_tokens_key"]: max_tokens})
    ms = int((time.perf_counter() - t0) * 1000)
    msg = resp.choices[0].message
    return (msg.content or getattr(msg, "reasoning_content", None) or ""), {"ms": ms, "model": model}
