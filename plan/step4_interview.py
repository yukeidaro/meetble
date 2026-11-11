"""Step 4: interview the user (max 3 questions grounded in findings), then match needs x offers."""
import json

from . import llm
from .common import (rules, S, N, I, SHARED_RULES, num, text, arr, context_block, emit, finding_ids, keep_known, obj, scrub)

MAX_Q = 3

Q_SCHEMA = obj({
    "questions": arr(obj({
        "question": S,
        "why": S,
        "need_id": S,
        "evidence": arr(S),
        "answer_chips": arr(S),
    })),
})

M_SCHEMA = obj({
    "offer_inventory": arr(obj({"offer": S, "proof_url": S, "strength": I, "source": S})),
    "matches": arr(obj({"need_id": S, "offer": S, "match": N, "reason": S})),
})

SYSTEM = (
    "You are the interviewer of Meetble, an agent that finds the best way for a founder to reach one person. "
    "Step 4 runs after the research: ask the user only what the research cannot answer. "

)


def _needs_block(state):
    return "<needs>\n" + json.dumps(scrub(state.get("needs", [])), ensure_ascii=False, indent=1) + "\n</needs>\n"


def _offers_block(state, profile):
    offers = state.get("offer_inventory") or (profile or {}).get("offer_inventory_draft") or []
    return "<offer_inventory>\n" + json.dumps(scrub(offers), ensure_ascii=False, indent=1) + "\n</offer_inventory>\n"


def make_questions(state, profile):
    task = f"""Write at most {MAX_Q} questions for the user. Each must:
- be grounded in one finding and one need, e.g. "Boris talked about data infra for AI on a podcast. Do you have users or data there?"
  or "Do you know anyone at these 3 portfolio companies?"
- ask about something only the user knows (their contacts, data, users, budget, willingness to travel tonight),
  not something already in the profile
- be answerable in one line; give 2-4 short answer_chips (likely answers) the UI can show as buttons
Order by how much the answer would change the plan."""
    out = llm.call_json(SYSTEM + rules(), context_block(state, profile) + _needs_block(state) + _offers_block(state, profile) + task, Q_SCHEMA)
    known = finding_ids(state)
    out = scrub(out) if isinstance(out, dict) else {}
    qs = []
    for q in [q for q in (out.get("questions") or []) if isinstance(q, dict) and text(q.get("question"))][:MAX_Q]:
        q["question"] = text(q.get("question"))
        q["why"] = text(q.get("why"))
        q["evidence"] = keep_known(q.get("evidence"), known)
        q["answer_chips"] = [text(c) for c in (q.get("answer_chips") or []) if c][:4]
        qs.append(q)
    return qs


def console_ask(i, q):
    print()
    print(f"  Q{i}. {q['question']}")
    if q.get("why"):
        print(f"      why: {q['why']}")
    chips = q.get("answer_chips") or []
    for j, c in enumerate(chips, 1):
        print(f"      [{j}] {c}")
    try:
        a = input("      Your answer (number, text, or Enter to skip): ").strip()
    except EOFError:
        a = ""
    if a.isdigit() and 1 <= int(a) <= len(chips):
        a = chips[int(a) - 1]
    return a


def run(state, profile, ask=console_ask, answers=None):
    """ask(i, question) -> str. `answers` (list of str) skips asking, for scripted runs."""
    emit(4, "Interview you on what you can offer", "running")
    qs = make_questions(state, profile)
    interview = []
    for i, q in enumerate(qs, 1):
        if answers is not None:
            a = answers[i - 1] if i - 1 < len(answers) else ""
        else:
            a = ask(i, q)
        a = scrub(text(a).strip())  # answers are shown on screen and saved: same outward-text rule
        interview.append(dict(q, answer=a or ""))
        emit(4, f"Q{i}: {q['question'][:90]}", "done" if a else "skipped", a[:80] if a else "no answer")
    state["interview"] = interview

    task = """Update the user's Offer Inventory with what they just said in the interview (keep earlier offers that still hold,
add new ones, drop ones the answers contradict). strength: 1 weak, 2 solid, 3 strong and provable. source: "profile" or "interview".
Then match every need to the best offer: match 0-1 (0 = nothing fits), with a one-line reason. Use need ids exactly as given."""
    user = (context_block(state, profile) + _needs_block(state) + _offers_block(state, profile)
            + "<interview>\n" + json.dumps(scrub(interview), ensure_ascii=False, indent=1) + "\n</interview>\n" + task)
    out = scrub(llm.call_json(SYSTEM + rules(), user, M_SCHEMA))
    out = out if isinstance(out, dict) else {}

    offers = []
    for o in out.get("offer_inventory") or []:
        if not isinstance(o, dict) or not text(o.get("offer")):
            continue
        o["strength"] = max(1, min(3, int(num(o.get("strength"), 1))))
        offers.append(o)
    state["offer_inventory"] = offers or state.get("offer_inventory", [])

    by_id = {n["id"]: n for n in state.get("needs", []) if "id" in n}
    for m in out.get("matches") or []:
        n = by_id.get(m.get("need_id")) if isinstance(m, dict) else None
        if n is None:
            continue
        score = max(0.0, min(1.0, num(m.get("match"))))
        if score >= n.get("match", 0):
            n["matched_offer"] = m.get("offer", "")
            n["match"] = score
            n["match_reason"] = m.get("reason", "")
    best = max(state.get("needs", []), key=lambda n: n.get("match", 0), default=None)
    note = f"best match: {best['type']} {round(best.get('match', 0) * 100)}%" if best else "no needs"
    emit(4, "Interview you on what you can offer", "done", f"{len(offers)} offers, {note}")
    return state
