"""Step 5: actions the agent can take, each with a likelihood % computed in code."""
import json

from . import llm
from .common import (S, N, SHARED_RULES, num, text, arr, context_block, contains_employer, days_until, emit,
                     finding_ids, keep_known, obj, scrub)
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
    "You are the strategist of Meetball, an agent that finds the best way for a founder to reach one person. "
    "Step 5: propose concrete actions and score them with a base rate and four multipliers. Never output a final %; code computes it. "
    + SHARED_RULES
)


def _ranges_text():
    b = "\n".join(f"  {t}: base {lo:.2f}-{hi:.2f}" for t, (lo, hi) in BASE_RANGE.items())
    m = "\n".join(f"  {k}: {lo}-{hi}" for k, (lo, hi) in MULT_RANGE.items())
    return f"Base-rate ranges by type:\n{b}\nMultiplier ranges (1.0 = neutral):\n{m}"


def run(state, profile):
    emit(5, "Rank the actions with a % each", "running")
    goal = state.get("goal", {})
    days_left = days_until(goal.get("deadline"))
    budget = num(goal.get("budget_jpy"), None) if goal.get("budget_jpy") not in (None, "") else None

    task = f"""Propose 6-10 actions to reach the target by the deadline (days left: {days_left if days_left is not None else "unknown"}).
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
    out = scrub(llm.call_json(SYSTEM, blocks + task, SCHEMA, max_tokens=32000))
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
        actions.append(score_action(a, days_left, budget))

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
    state["p_total"] = total_chance(actions)
    state["p_total_note"] = "1 - product(1 - p) over actions that fit the deadline and budget; assumes the actions are independent."

    for a in actions:
        flag = "" if a["fits_deadline"] and a["fits_budget"] else (" · too late" if not a["fits_deadline"] else " · over budget")
        emit(5, f"{pct(a['p']):>4}  {a['title'][:80]}", "done",
             f"¥{a['cost_jpy']:,} · {a['hours']}h · {a['days_to_outcome']}d{flag}")
    if contains_employer(actions):  # should never happen; scrub() runs on the model output
        emit(5, "Outward text check", "error", "former employer name found in drafts")
    emit(5, "Rank the actions with a % each", "done", f"chance of reaching them by the deadline: {pct(state['p_total'])}")
    return state
