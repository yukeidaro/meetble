"""Tiny Anthropic Messages API client on the standard library (pip is not needed).

call_json(system, user, schema) returns a dict that matches `schema`, using
structured outputs (output_config.format). If the API rejects the schema, it
retries once without it and parses the JSON from the text.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
# Settings are read at call time, so values that load_env() reads from .env apply.
def _model():
    return os.environ.get("HF_MODEL", "claude-opus-5-5")


def _effort():
    return os.environ.get("HF_EFFORT", "medium")  # low | medium | high


def _timeout():
    try:
        return max(30, int(os.environ.get("HF_TIMEOUT_S", "240")))
    except ValueError:
        return 240


def load_env(start_dir=None):
    """Load KEY=VALUE lines from the nearest .env (cwd, then parents) without overriding real env vars."""
    d = os.path.abspath(start_dir or os.getcwd())
    while True:
        p = os.path.join(d, ".env")
        if os.path.isfile(p):
            from .common import read_text  # handles UTF-16 files made by PowerShell 5
            for line in read_text(p).splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip().removeprefix("export ").strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
            return p
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


class LLMError(RuntimeError):
    pass


def _post(body):
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise LLMError("ANTHROPIC_API_KEY is not set (put it in .env)")
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    last = None
    timeouts = 0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=_timeout()) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:800]
            if e.code in (429, 500, 502, 503, 504, 529) and attempt < 3:
                last = LLMError(f"HTTP {e.code}: {detail}")
                time.sleep(2 ** (attempt + 1))
                continue
            raise LLMError(f"HTTP {e.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = LLMError(f"network error: {e}")
            if isinstance(e, TimeoutError) or "timed out" in str(e):
                timeouts += 1
                if timeouts >= 2:  # a timed-out call may still be billed: at most one retry
                    raise last from None
            if attempt < 3:
                time.sleep(2 ** (attempt + 1))
                continue
            raise last from None
    raise last


def _text_of(resp):
    if resp.get("stop_reason") == "refusal":
        raise LLMError("the model declined this request (stop_reason=refusal)")
    parts = [b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text"]
    text = "".join(parts).strip()
    if resp.get("stop_reason") == "max_tokens":
        raise LLMError("response was cut off at max_tokens")
    return text


def _parse_json(text):
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        a, b = text.find("{"), text.rfind("}")
        if a >= 0 and b > a:
            return json.loads(text[a : b + 1])
        raise


def _checked(out, schema):
    """Reject output that is not an object with the schema's top-level keys (never report an empty success)."""
    if not isinstance(out, dict):
        raise LLMError(f"model returned {type(out).__name__}, expected a JSON object")
    missing = [k for k in schema.get("required", []) if k not in out]
    if missing:
        raise LLMError(f"model output is missing {missing}")
    for k, sub in schema.get("properties", {}).items():
        want = sub.get("type")
        if want == "array" and not isinstance(out.get(k), list):
            raise LLMError(f"model output field {k!r} is not a list")
        if want == "object" and not isinstance(out.get(k), dict):
            raise LLMError(f"model output field {k!r} is not an object")
    return out


def call_json(system, user, schema, max_tokens=16000):
    base = {
        "model": _model(),
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "thinking": {"type": "adaptive"},
    }
    body = dict(base, output_config={"effort": _effort(), "format": {"type": "json_schema", "schema": schema}})
    try:
        return _checked(_parse_json(_text_of(_post(body))), schema)
    except LLMError as e:
        if "HTTP 400" not in str(e):
            raise
    except ValueError:
        pass  # unparsable JSON: try once more without the schema
        # Schema or effort not accepted: fall back to plain JSON instructions.
    body = dict(base)
    body["messages"] = [{
        "role": "user",
        "content": user + "\n\nReturn only one JSON object that matches this JSON Schema, no prose:\n"
        + json.dumps(schema),
    }]
    try:
        return _checked(_parse_json(_text_of(_post(body))), schema)
    except ValueError as e:  # JSONDecodeError
        raise LLMError(f"model did not return valid JSON: {e}") from None
