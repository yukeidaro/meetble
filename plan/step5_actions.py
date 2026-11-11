"""Step 5: actions the agent can take, each with a likelihood % computed in code."""
import json

from . import llm
from .common import (rules, S, N, SHARED_RULES, num, text, arr, context_block, contains_employer, days_until, emit,
                     finding_ids, keep_known, obj, scrub)
from .common import CONSENT, employment_status_words
from .common import hide_employer as common_hide
from .scoring import ACTION_TYPES, BASE_RANGE, MULT_RANGE, pct, score_action, total_chance

SCHEMA = obj({
    "actions": arr(obj({
        "type": {"type": "string", "enum": ACTION_TYPES},
        "title": S,
        "how": arr(S),
        "channel_url": S,
        "base_rate": N,
        "m_relevance": N,
        "m_timing": N,
        "m_warmth": N,
        "m_channel": N,
        "reasons": obj({"base_rate": S, "m_relevance": S, "m_timing": S, "m_warmth": S, "m_channel": S}),
        "cost_jpy": N,
        "hours": N,
        "days_to_outcome": N,
        "evidence": arr(S),
        "need_id": S,
        "draft": S,
    })),
    "sequence": arr(obj({"action_index": {"type": "integer"}, "when": S})),
    "summary": S,
})

SYSTEM = (
    "You are the strategist of Meetble, an agent that finds the best way for a founder to reach one person. "
    "Step 5: propose concrete actions and score them with a base rate and four multipliers. Never output a final %; code computes it. "

)


def _ranges_text():
    b = "\n".join(f"  {t}: base {lo:.2f}-{hi:.2f}" for t, (lo, hi) in BASE_RANGE.items())
    m = "\n".join(f"  {k}: {lo}-{hi}" for k, (lo, hi) in MULT_RANGE.items())
    return f"Base-rate ranges by type:\n{b}\nMultiplier ranges (1.0 = neutral):\n{m}"


LIVE_KEYS = ("live", "is_live", "slots_confirmed")
UNVERIFIED_BOOKING_CAP = 0.05
ONLY_ROUTE_BOOKING_CAP = 0.15
BOOKING_HOSTS = ("calendly.com", "cal.com", "savvycal.com", "zcal.co", "tidycal.com", "koalendar.com", "youcanbook.me")


def _norm_url(u):
    return text(u).lower().split("?")[0].split("#")[0].rstrip("/").replace("https://", "").replace("http://", "").replace("www.", "")


def is_booking_action(a, state):
    """True if the action books through a booking page: by type, by a known booking_pages URL, or by a booking host."""
    if a.get("type") == "booking_page":
        return True
    u = _norm_url(a.get("channel_url"))
    if not u:
        return False
    known = {_norm_url(b.get("url")) for b in (state.get("booking_pages") or []) if isinstance(b, dict)}
    return u in known or any(u.startswith(h) or ("." + h) in u for h in BOOKING_HOSTS)


def booking_is_live(a, live_urls):
    """A booking action keeps its score only if its own page is verified live (or it names no URL and some page is live)."""
    u = _norm_url(a.get("channel_url"))
    live = {_norm_url(x) for x in live_urls if x}
    return (u in live) if u else bool(live_urls)


def live_booking_urls(state):
    """Booking pages the research verified as in use. A page that merely exists (e.g. a dead Calendly) doesn't count."""
    urls = []
    for b in state.get("booking_pages") or []:
        if not isinstance(b, dict):
            continue
        if b.get("slots_confirmed") is False:
            continue
        if any(b.get(k) is True for k in LIVE_KEYS) or str(b.get("status", "")).lower() == "live":
            urls.append(b.get("url", ""))
    return urls


def run(state, profile):
    emit(5, "Rank the actions with a % each", "running")
    goal = state.get("goal", {})
    days_left = days_until(goal.get("deadline"))
    budget = num(goal.get("budget_jpy"), None) if goal.get("budget_jpy") not in (None, "") else None

    live = live_booking_urls(state)
    booking_note = (f"Verified live booking pages: {live}." if live else
                    "No booking page was verified as live (a page that exists may be unused). "
                    "Do not make booking_page the main route; if you include it, say it must be checked first.")
    task = f"""{booking_note}
Propose 6-10 actions to reach the target by the deadline (days left: {days_left if days_left is not None else "unknown"}).
Action types:
- referral: ask someone in the user's network who knows the target; draft the ask plus a forwardable blurb
- booking_page: book a slot on a public booking page found in the research
- event: meet at an event they publicly speak at or attend (including tonight's event if the research shows one), with a prepared question about their talk
- office_delivery: send a book or coffee they mentioned to their office, with a note tied to their work
- cold_email / cold_dm (X or LinkedIn): value-first, citing something they actually said
- paid_consult: a paid slot they list (Intro, Clarity.fm and similar); only if research shows one
- paid_intro: offer a mutual contact a fee or favour for a double-opt-in intro
- network_first: meet 2-3 people from their inner circle who are easier to reach
- post_and_mention: post on their favourite topic, then mention them once it gets traction
Include every type that has any basis, even at 1%. Do not repeat a type unless the channel differs.
{_ranges_text()}
For each action: one-line reason per number; cost_jpy, hours of the user's time, days_to_outcome; evidence = finding ids;
need_id = the need it serves; how = 1-3 concrete steps; channel_url = the URL to act on if known, else "".
draft = the message to send (or "" if none): under 120 words, specific, cites something the target actually said or did,
leads with what the user offers (from the offer inventory and interview), ends with one small ask.
sequence: the recommended order (indexes into actions, from 0) with when to do each, fitted to the deadline and budget.
summary: one sentence on the best route."""
    blocks = (
        context_block(state, profile)
        + "<persona>\n" + str(scrub(state.get("persona", ""))) + "\n</persona>\n"
        + "<needs>\n" + json.dumps(scrub(state.get("needs", [])), ensure_ascii=False, indent=1) + "\n</needs>\n"
        + "<availability>\n" + json.dumps(scrub(state.get("availability", {})), ensure_ascii=False, indent=1) + "\n</availability>\n"
        + "<offer_inventory>\n" + json.dumps(scrub(state.get("offer_inventory", [])), ensure_ascii=False, indent=1) + "\n</offer_inventory>\n"
        + "<interview>\n" + json.dumps(scrub(state.get("interview", [])), ensure_ascii=False, indent=1) + "\n</interview>\n"
    )
    out = scrub(llm.call_json(SYSTEM + rules(), blocks + task, SCHEMA, max_tokens=32000))
    out = out if isinstance(out, dict) else {}
    known = finding_ids(state)
    need_ids = {n.get("id") for n in state.get("needs", [])}

    actions = []
    for idx, a in enumerate(out.get("actions") or []):  # idx = model's own index, so sequence stays aligned
        if not isinstance(a, dict) or a.get("type") not in BASE_RANGE:
            continue
        a["title"] = text(a.get("title")) or a["type"].replace("_", " ")
        a["draft"] = text(a.get("draft"))
        a["channel_url"] = text(a.get("channel_url"))
        a["how"] = [text(h) for h in (a.get("how") or []) if h]
        a["reasons"] = a.get("reasons") if isinstance(a.get("reasons"), dict) else {}
        a["evidence"] = keep_known(a.get("evidence"), known)
        if a.get("need_id") not in need_ids:
            a["need_id"] = ""
        a["status"] = "proposed"
        a["_src_index"] = idx
        a = score_action(a, days_left, budget)
        actions.append(a)

    others = [a for a in actions if not is_booking_action(a, state)]
    cap = UNVERIFIED_BOOKING_CAP if others else ONLY_ROUTE_BOOKING_CAP
    for a in actions:
        if is_booking_action(a, state) and not booking_is_live(a, live):
            a["p"] = round(min(a["p"], cap), 4)
            a.setdefault("flags", []).append(f"booking page not verified as live (no open slots confirmed): capped at {round(cap * 100)}%")
            if "unverified" not in a["title"].lower():
                a["title"] += " (unverified page)"

    actions.sort(key=lambda a: (not (a["fits_deadline"] and a["fits_budget"]), -a["p"]))
    src_to_id = {}
    for i, a in enumerate(actions, 1):
        a["id"] = f"a{i}"
        src_to_id[a.pop("_src_index")] = a["id"]

    seq = []
    for s in out.get("sequence") or []:
        if not isinstance(s, dict):
            continue
        aid = src_to_id.get(int(num(s.get("action_index"), -1)))
        if aid and aid not in [x["action_id"] for x in seq]:
            seq.append({"action_id": aid, "when": s.get("when", "")})

    state["actions"] = actions
    state["sequence"] = seq
    state["plan_summary"] = text(out.get("summary"))
    state["p_total"] = total_chance(actions, budget)
    state["p_total_note"] = ("1 - product(1 - p) over actions that fit the deadline, best first, "
                             "while their combined cost stays within budget; assumes the actions are independent.")

    for a in actions:
        # With consent, status words are fine only when the profile states the status; otherwise they are a guess.
        words = [] if CONSENT.get("given") and CONSENT.get("status_known") else employment_status_words(a.get("draft", ""))
        if words:  # flagged on the card so Yu edits before sending; not silently rewritten
            a.setdefault("flags", []).append("draft states your employment status: " + ", ".join(words))
            emit(5, f"Check draft for {a['id']}", "error", "mentions " + ", ".join(words) + "; edit before sending")
    for a in actions:
        flag = "" if a.get("in_total") else (" · too late" if not a["fits_deadline"] else " · over budget")
        emit(5, f"{pct(a['p']):>4}  {a['title'][:80]}", "done",
             f"¥{a['cost_jpy']:,} · {a['hours']}h · {a['days_to_outcome']}d{flag}")
    if common_hide() and contains_employer(actions):  # should never happen; scrub() runs on the model output
        emit(5, "Outward text check", "error", "former employer name found in drafts")
    emit(5, "Rank the actions with a % each", "done", f"chance of reaching them by the deadline: {pct(state['p_total'])}")
    return state
