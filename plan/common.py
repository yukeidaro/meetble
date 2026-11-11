"""Shared helpers: checklist output, state I/O, profile scrubbing, prompt context."""
import datetime as dt
import json
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


def read_json(path):
    with open(path, encoding="utf-8-sig") as f:  # -sig: PowerShell 5 writes a BOM
        return json.load(f)


def write_json(path, data):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ---------- outward-facing text rules ----------
# Anything shown on screen or sent out must not name Yu's former employer.
# Root-cause fix: the model never sees the name, so it can't write it.
_EMPLOYER = [
    (re.compile(r"日本マイクロソフト"), "a global big-tech company's Japan office"),
    (re.compile(r"マイクロソフト"), "a global big-tech company"),
    (re.compile(r"Microsoft Japan", re.I), "a global big-tech company's Japan office"),
    (re.compile(r"Microsoft's", re.I), "a global big-tech company's"),
    (re.compile(r"Microsoft", re.I), "a global big-tech company"),
]


def scrub(value):
    """Recursively replace the former employer's name in strings."""
    if isinstance(value, str):
        for rx, rep in _EMPLOYER:
            value = rx.sub(rep, value)
        return value
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value


def contains_employer(value):
    s = json.dumps(value, ensure_ascii=False).lower()
    return "microsoft" in s or "マイクロソフト" in s


def num(x, default=0.0):
    """float() that never raises: "80%" -> 0.8, "high" -> default, None -> default."""
    if isinstance(x, bool):
        return default
    if isinstance(x, (int, float)):
        return float(x) if x == x else default
    if isinstance(x, str):
        t = x.strip().replace(",", "").replace("\u00a5", "").replace("$", "")
        pctv = t.endswith("%")
        try:
            v = float(t.rstrip("%"))
        except ValueError:
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
    """Drop evidence ids the model invented."""
    return [i for i in (ids or []) if i in known]


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
    if low in ("today", "tonight", "now"):
        return 0
    if low == "tomorrow":
        return 1
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        t = None
    if t is not None and (len(s) > 10):
        now = dt.datetime.now(t.tzinfo) if t.tzinfo else dt.datetime.now()
        return round((t - now).total_seconds() / 86400, 2)
    try:
        d = dt.date.fromisoformat(s[:10])
    except ValueError:
        return None
    return (d - dt.date.today()).days


SHARED_RULES = (
    "Rules: work only from the findings and the user profile given; cite finding ids exactly as given; "
    "never invent facts, quotes, people or URLs. Write in English. "
    "Never name the user's former employer; describe it as 'a global big-tech company' if needed. "
    "Respect the profile's 'sensitivities'. Stay on public professional information."
)
