"""Step 3: guess what the target wants, and when they are available."""
from . import llm
from .common import (S, N, SHARED_RULES, num, text, arr, context_block, emit, finding_ids, keep_known, obj, scrub)

NEED_TYPES = ["money", "network", "idea", "gift", "help"]

SCHEMA = obj({
    "persona": S,
    "needs": arr(obj({
        "type": {"type": "string", "enum": NEED_TYPES},
        "hypothesis": S,
        "evidence": arr(S),
        "counter_signal": S,
        "confidence": N,
    })),
    "availability": obj({
        "timezone_guess": S,
        "booking_page_url": S,
        "windows": arr(obj({"when": S, "why": S, "evidence": arr(S)})),
        "summary": S,
    }),
    "gift_ideas": arr(obj({"item": S, "cost_jpy": N, "note": S, "evidence": arr(S)})),
})

SYSTEM = (
    "You are the needs analyst of Meetble, an agent that finds the best way for a founder to reach one person. "
    "Step 3: from the research, guess what the target wants right now and when they can be reached. "
    + SHARED_RULES
)

TASK = """Do Step 3 for the target in research_context.goal.

1. persona: 2-3 sentences: who they are now, what they care about, the tone of their public voice.
2. needs: 4-7 hypotheses, covering each type where evidence allows:
   - money: as an investor, are they looking for deal flow or co-investors? as a founder, customers or revenue?
   - network: who would they want to meet (customers for their portfolio, engineers to hire, other investors)?
   - idea: which themes or theses get them excited; what kind of person or hook fits their tone?
   - gift: a book, coffee, or meal tied to something they actually said
   - help: role KPIs, recent asks ("looking for", "hiring"), current events (new fund, launch, job change)
   Each need: evidence = finding ids, a counter_signal (what would make it wrong), confidence 0-1.
3. availability: timezone from posting times or location, any public booking page URL (empty if none),
   likely windows before the deadline (talks, events, office hours, the event tonight if any), and a one-line summary.
4. gift_ideas: 0-3 items with a rough cost in JPY and a one-line note tied to their work.
If evidence is thin, say so in the hypothesis and lower confidence; do not pad."""


def run(state, profile):
    emit(3, "Guess what they want and when they are free", "running")
    from .step5_actions import live_booking_urls
    live = live_booking_urls(state)
    note = (f"Booking pages verified as live: {live}." if live else
            "No booking page was verified as live: if one is listed, call it 'found but not verified as in use', never 'verified'.")
    out = llm.call_json(SYSTEM, context_block(state, profile) + "\n" + note + "\n" + TASK, SCHEMA)
    out = scrub(out)
    known = finding_ids(state)

    needs = []
    out = out if isinstance(out, dict) else {}
    for n in out.get("needs") or []:
        if not isinstance(n, dict) or n.get("type") not in NEED_TYPES:
            continue
        n["hypothesis"] = text(n.get("hypothesis"))
        n["counter_signal"] = text(n.get("counter_signal"))
        n["evidence"] = keep_known(n.get("evidence"), known)
        n["confidence"] = max(0.0, min(1.0, num(n.get("confidence"))))
        n.setdefault("matched_offer", "")
        n.setdefault("match", 0.0)
        needs.append(n)
    needs.sort(key=lambda n: -n["confidence"])
    for i, n in enumerate(needs, 1):
        n["id"] = f"n{i}"

    avail = out.get("availability") if isinstance(out.get("availability"), dict) else {}
    avail["summary"] = text(avail.get("summary"))
    avail["windows"] = [w for w in (avail.get("windows") or []) if isinstance(w, dict)]
    for w in avail["windows"]:
        w["evidence"] = keep_known(w.get("evidence"), known)
    gifts = [g for g in (out.get("gift_ideas") or []) if isinstance(g, dict)]
    for g in gifts:
        g["evidence"] = keep_known(g.get("evidence"), known)
        g["cost_jpy"] = max(0, int(num(g.get("cost_jpy"))))

    state["persona"] = text(out.get("persona"))
    state["needs"] = needs
    state["availability"] = avail
    state["gift_ideas"] = gifts

    for n in needs:
        emit(3, f"Need ({n['type']}): {n['hypothesis'][:90]}", "done", f"confidence {round(n['confidence']*100)}%")
    emit(3, "Availability", "done", avail.get("summary", "")[:140] or "no signal")
    emit(3, "Guess what they want and when they are free", "done", f"{len(needs)} needs")
    return state
