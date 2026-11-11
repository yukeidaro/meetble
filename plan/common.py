"""Shared helpers: checklist output, state I/O, profile scrubbing, prompt context."""
import datetime as dt
import json
import math
import os
import re
import sys

ICONS = {"running": "⏳", "done": "✅", "error": "❌", "skipped": "⏭️"}
EVENTS = []  # every emitted checklist line, copied into state["events_log"]


def setup_console():
    # PowerShell 5 consoles may not be UTF-8; never crash on an icon.
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def emit(step, label, status="done", note=""):
    """Print one checklist line in the shared format: [icon] label (note)."""
    icon = ICONS.get(status, "•")
    line = f"[{icon}] Step {step} · {label}" + (f" ({note})" if note else "")
    print(line, flush=True)
    EVENTS.append({"step": step, "label": label, "status": status, "note": note,
                   "at": dt.datetime.now().isoformat(timespec="seconds")})


def obj(props, required=None):
    """Strict JSON-schema object for structured outputs."""
    return {"type": "object", "properties": props, "required": required or list(props), "additionalProperties": False}


def arr(items):
    return {"type": "array", "items": items}


S = {"type": "string"}
N = {"type": "number"}
I = {"type": "integer"}


def read_text(path):
    """Read UTF-8 (with or without BOM) or UTF-16 (PowerShell 5 `>` / Out-File default)."""
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig")


def read_json(path):
    return json.loads(read_text(path))


def write_json(path, data):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2)  # build first: a failure can't truncate the file
    with open(path, "w", encoding="utf-8", errors="replace") as f:
        f.write(text)


# ---------- outward-facing text rules ----------
# Anything shown on screen or sent out must not name Yu's former employer.
# Root-cause fix: the model never sees the name, so it can't write it.
_EMPLOYER = [
    (re.compile(r"日本マイクロソフト"), "a global big-tech company"),
    (re.compile(r"マイクロソフト"), "a global big-tech company"),
    (re.compile(r"Microsoft Japan", re.I), "a global big-tech company"),
    (re.compile(r"Microsoft's", re.I), "a global big-tech company's"),
    (re.compile(r"Microsoft", re.I), "a global big-tech company"),
]


def hide_employer():
    """Off by default (Yu wants the past employer shown). Set HF_HIDE_EMPLOYER=1 in .env to hide it everywhere."""
    return os.environ.get("HF_HIDE_EMPLOYER", "").strip().lower() in ("1", "true", "yes")


def scrub(value):
    """Recursively replace the former employer's name in strings (only when hide_employer() is on)."""
    if not hide_employer():
        return value
    return _scrub(value)


def _scrub(value):
    if isinstance(value, str):
        if value.startswith(("http://", "https://")):
            return value  # keep source links working; they are citations, not prose
        for rx, rep in _EMPLOYER:
            value = rx.sub(rep, value)
        return value
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, dict):
        return {_scrub(k) if isinstance(k, str) else k: _scrub(v) for k, v in value.items()}
    return value


def contains_employer(value):
    s = json.dumps(value, ensure_ascii=False).lower()
    return "microsoft" in s or "マイクロソフト" in s


def num(x, default=0.0):
    """float() that never raises: "80%" -> 0.8, "high" -> default, None -> default."""
    if isinstance(x, bool):
        return default
    if isinstance(x, (int, float)):
        try:
            x = float(x)
        except OverflowError:
            return default
        return x if math.isfinite(x) else default
    if isinstance(x, str):
        t = x.strip().replace(",", "").replace("\u00a5", "").replace("$", "")
        pctv = t.endswith("%")
        try:
            v = float(t.rstrip("%"))
        except ValueError:
            return default
        if not math.isfinite(v):
            return default
        return v / 100 if pctv else v
    return default


def text(x):
    return x if isinstance(x, str) else ("" if x is None else str(x))


# ---------- state normalisation ----------
def normalize_state(state):
    """Accept the Steps 1-2 output with small shape differences; never fail on a missing key."""
    state = dict(state) if isinstance(state, dict) else {}
    goal = state.get("goal")
    goal = dict(goal) if isinstance(goal, dict) else ({"target_name": goal} if isinstance(goal, str) else {})
    tid = state.get("target_id")
    tid = dict(tid) if isinstance(tid, dict) else ({"name": tid} if isinstance(tid, str) else {})
    name = goal.get("target_name") or goal.get("target") or tid.get("name") or "the target"
    goal["target"] = goal["target_name"] = text(name)
    state["goal"] = goal
    state["target_id"] = tid
    raw = state.get("findings")
    if isinstance(raw, dict):
        raw = list(raw.values())
    if not isinstance(raw, list):
        raw = []
    findings = []
    for i, f in enumerate(raw, 1):
        if not isinstance(f, dict):
            continue
        f = dict(f)
        f["id"] = str(f.get("id") or f"f{i}")
        f["confidence"] = num(f.get("confidence"))
        findings.append(f)
    state["findings"] = findings
    if not isinstance(state.get("offer_inventory"), list):
        state["offer_inventory"] = []
    state["offer_inventory"] = scrub(state["offer_inventory"])  # it is shown on the board
    if not isinstance(state.get("events_log"), list):
        state["events_log"] = []
    return state


def finding_ids(state):
    return {f["id"] for f in state.get("findings", [])}


def keep_known(ids, known):
    """Drop evidence ids the model invented (and anything that isn't an id string)."""
    if not isinstance(ids, list):
        return []
    return [i for i in ids if isinstance(i, str) and i in known]


def _short(s, n):
    s = str(s or "")
    return s if len(s) <= n else s[: n - 1] + "…"


def findings_for_prompt(state, limit=120):
    """Compact, stable text block of findings for the prompt."""
    rows = []
    fs = sorted(state.get("findings", []), key=lambda f: -num(f.get("confidence")))[:limit]
    for f in fs:
        rows.append({
            "id": f["id"],
            "step": f.get("step"),
            "dimension": f.get("dimension") or f.get("kind"),
            "claim": _short(f.get("claim"), 400),
            "quote": _short(f.get("quote"), 400),
            "date": f.get("date") or "",
            "source_url": f.get("source_url") or "",
            "confidence": f.get("confidence"),
        })
    return json.dumps(scrub(rows), ensure_ascii=False, indent=1)


def context_block(state, profile, include=("goal", "target_id", "summary", "booking_pages", "events", "email_guess")):
    ctx = {k: state.get(k) for k in include if state.get(k) not in (None, "", [], {})}
    ctx["today"] = dt.date.today().isoformat()
    return (
        "<research_context>\n" + json.dumps(scrub(ctx), ensure_ascii=False, indent=1) + "\n</research_context>\n"
        "<findings>\n" + findings_for_prompt(state) + "\n</findings>\n"
        "<user_profile>\n" + json.dumps(scrub(profile or {}), ensure_ascii=False, indent=1) + "\n</user_profile>\n"
    )


def days_until(deadline):
    """Days from now to the deadline (0 = later today; negative = passed). None if unknown.
    A full timestamp is compared in its own time zone, so the PC's clock zone doesn't shift the day."""
    if not deadline:
        return None
    s = str(deadline).strip()
    low = s.lower()
    def to_end_of(day):
        end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time())
        return round((end - dt.datetime.now()).total_seconds() / 86400, 3)

    if low in ("today", "tonight", "now"):
        return to_end_of(dt.date.today())
    if low == "tomorrow":
        return to_end_of(dt.date.today() + dt.timedelta(days=1))
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        t = None
    if t is not None and (len(s) > 10):
        now = dt.datetime.now(t.tzinfo) if t.tzinfo else dt.datetime.now()
        return round((t - now).total_seconds() / 86400, 3)
    try:
        d = dt.date.fromisoformat(s[:10])
    except ValueError:
        return None
    return to_end_of(d)


# Set by __main__ after the consent question at start-up.
CONSENT = {"given": False}

_BASE_RULES = (
    "Rules: work only from the findings and the user profile given; cite finding ids exactly as given; "
    "never invent facts, quotes, people or URLs. Write in English. Stay on public professional information. "
)
_STRICT = (
    "The user's past employer may be named, but only as a past achievement (e.g. 'I spent 4 years in Azure GTM at <company>'). "
    "Never state or imply whether the user still works there: never call the user ex-<company>, a former employee, an alum, "
    "or say they left or joined somewhere else. Respect the profile's 'sensitivities'."
)
_OPEN = (
    "The user consented to sharing anything in their profile in outreach, including their career history and current status; "
    "use whatever detail makes the message most specific and credible, as long as it is true to the profile. "
    "State employment status only as the profile states it. "
    "Never include a company's confidential information (non-public numbers, customer names)."
)


_NO_STATUS = (
    " The profile does not say whether the user still works at their past employer, so never say or imply it either way: "
    "no ex-/former/alum, no 'left', 'leaving', 'quit', 'did it myself', 'before this', 'still at'. "
    "Describe past roles only as achievements ('I spent 4 years in Azure GTM at <company>')."
)


def profile_states_status(profile):
    """True if the profile says where the user works now (e.g. employment_status or current_employer)."""
    p = profile if isinstance(profile, dict) else {}
    return any(str(p.get(k) or "").strip() for k in ("employment_status", "current_employer"))


def rules():
    if not CONSENT.get("given"):
        return _BASE_RULES + _STRICT
    return _BASE_RULES + _OPEN + ("" if CONSENT.get("status_known") else _NO_STATUS)


SHARED_RULES = _BASE_RULES + _STRICT  # kept for imports; prompts call rules() at run time


def scrub_output(state):
    """Scrub everything we write, except the raw findings (facts about the target, e.g. their own past jobs)."""
    findings = state.get("findings", [])
    out = scrub({k: v for k, v in state.items() if k != "findings"})
    out["findings"] = findings
    return out


# Words that state the user's employment status ("ex-Microsoft", "alum", "left ...").
_EMP = r"(?:Microsoft|MSFT|Azure|マイクロソフト)"
_STATUS_RX = re.compile(r"\bex-?\s?" + _EMP + r"|" + _EMP + r"\s+alum\w*|\balum(?:na|nus|ni)?\b|\bformer(?:ly)?\s+(?:at\s+)?" + _EMP
                        + r"|\b(?:left|leaving|quit(?:ting)?)\s+" + _EMP + r"|\bstill\s+(?:at|work(?:ing)?\s+at)\s+" + _EMP, re.I)


def employment_status_words(text_value):
    """Phrases in a draft that state whether the user still works somewhere (profile sensitivity)."""
    return sorted({m.group(0) for m in _STATUS_RX.finditer(text_value or "")})
