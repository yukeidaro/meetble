"""Run Steps 3-5 on the Steps 1-2 research file.

PowerShell:
  python -m plan out\\research.json
  python -m plan out\\research.json --profile user_profile.json --out out\\plan.json
  python -m plan out\\research.json --answers "Yes, 20 data teams use us|No|Yes, I'm at the venue"
  python -m plan out\\research.json --no-interview
"""
import argparse
import json
import os
import sys
import time

from . import common, llm, step3_needs, step4_interview, step5_actions
from .scoring import pct


def find_profile(explicit, research_path):
    cands = [explicit] if explicit else [
        "user_profile.json",
        os.path.join(os.path.dirname(os.path.abspath(research_path)), "user_profile.json"),
        os.path.join(os.path.dirname(os.path.abspath(research_path)), "..", "user_profile.json"),
    ]
    for c in cands:
        if c and os.path.isfile(c):
            return common.read_json(c), os.path.abspath(c)
    if explicit:
        sys.exit(f"Profile not found: {explicit}")
    return {}, None


def parse_answers(s):
    if s is None:
        return None
    if os.path.isfile(s):
        data = common.read_json(s)
        if isinstance(data, dict):
            data = data.get("answers", [])
        if not isinstance(data, list):
            data = [data]
        return [str(x) for x in data]
    return [x.strip() for x in s.split("|")]


def write_report(state, path):
    g = state.get("goal", {})
    L = [f"# Meetble plan: {g.get('target_name') or g.get('target')}", ""]
    L.append(f"**Chance of reaching them by the deadline: {pct(state.get('p_total', 0))}**  ")
    L.append(f"Deadline: {g.get('deadline', 'not set')}. {state.get('plan_summary', '')}")
    L += ["", "## Who they are", state.get("persona", ""), "", "## What they want (Step 3)"]
    for n in state.get("needs", []):
        m = f" -> your offer: {n['matched_offer']} ({round(n.get('match', 0) * 100)}% fit)" if n.get("matched_offer") else ""
        L.append(f"- **{n['type']}** ({round(n['confidence'] * 100)}%): {n['hypothesis']}{m}  \n  counter-signal: {n.get('counter_signal', '')}")
    av = state.get("availability", {})
    L += ["", "## When they are available", av.get("summary", "")]
    for w in av.get("windows", []):
        L.append(f"- {w.get('when')}: {w.get('why')}")
    if state.get("interview"):
        L += ["", "## Your answers (Step 4)"]
        for q in state["interview"]:
            L.append(f"- {q['question']}  \n  **{q.get('answer') or '(skipped)'}**")
    L += ["", "## Actions (Step 5)", "", "| % | Action | Cost | Time | Days |", "|---|---|---|---|---|"]
    for a in state.get("actions", []):
        tag = "" if a["fits_deadline"] and a["fits_budget"] else " (outside deadline/budget)"
        L.append(f"| {pct(a['p'])} | {a['title']}{tag} | ¥{a['cost_jpy']:,} | {a['hours']}h | {a['days_to_outcome']} |")
    for a in state.get("actions", []):
        L += ["", f"### {pct(a['p'])} · {a['title']}",
              f"base {a['base_rate']:.2f} × relevance {a['m_relevance']} × timing {a['m_timing']} × warmth {a['m_warmth']} × channel {a['m_channel']}"]
        for k, v in (a.get("reasons") or {}).items():
            L.append(f"- {k}: {v}")
        for h in a.get("how", []):
            L.append(f"1. {h}")
        if a.get("channel_url"):
            L.append(f"Link: {a['channel_url']}")
        if a.get("draft"):
            L += ["", "> " + a["draft"].replace("\n", "\n> ")]
    if state.get("sequence"):
        L += ["", "## Recommended order"]
        for s in state["sequence"]:
            a = next((x for x in state["actions"] if x["id"] == s["action_id"]), None)
            if a:
                L.append(f"1. {a['title']} ({pct(a['p'])}): {s['when']}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def main(argv=None):
    common.setup_console()
    ap = argparse.ArgumentParser(prog="python -m plan", description="Meetble Steps 3-5")
    ap.add_argument("research", help="Steps 1-2 output, e.g. out\\research.json")
    ap.add_argument("--profile", help="user_profile.json (default: next to you or the research file)")
    ap.add_argument("--out", default=os.path.join("out", "plan.json"))
    ap.add_argument("--answers", help='Step 4 answers: "a|b|c" or a JSON file with a list')
    ap.add_argument("--no-interview", action="store_true", help="skip the Step 4 questions")
    args = ap.parse_args(argv)

    env = llm.load_env()
    if not os.path.isfile(args.research):
        sys.exit(f"Research file not found: {args.research} (run Steps 1-2 first)")
    state = common.normalize_state(common.read_json(args.research))
    profile, ppath = find_profile(args.profile, args.research)
    common.emit(3, "Load research and profile", "done",
                f"{len(state['findings'])} findings, profile: {os.path.basename(ppath) if ppath else 'none'}, .env: {'found' if env else 'not found'}")
    if not state.get("offer_inventory") and profile.get("offer_inventory_draft"):
        state["offer_inventory"] = common.scrub(profile["offer_inventory_draft"])

    t0 = time.time()
    try:
        state = step3_needs.run(state, profile)
        if args.no_interview:
            common.emit(4, "Interview you on what you can offer", "skipped", "--no-interview")
        else:
            state = step4_interview.run(state, profile, answers=parse_answers(args.answers))
        state = step5_actions.run(state, profile)
    except Exception as e:  # keep partial results for the demo instead of a bare traceback
        label = "Claude API call failed" if isinstance(e, llm.LLMError) else f"Unexpected error ({type(e).__name__})"
        common.emit("-", label, "error", str(e)[:300])
        common.write_json(args.out, dict(state, events_log=list(state.get("events_log") or []) + common.EVENTS))
        print(f"Partial results saved to {args.out}")
        return 2

    state["events_log"] = list(state.get("events_log") or []) + common.EVENTS
    common.write_json(args.out, state)
    md = os.path.splitext(args.out)[0] + ".md"
    write_report(state, md)
    print()
    print(f"Chance of reaching {state['goal'].get('target_name')} by the deadline: {pct(state['p_total'])}  ({time.time() - t0:.0f}s)")
    if state.get("actions"):
        top = state["actions"][0]
        print(f"Best action: {top['title']} ({pct(top['p'])})")
        if top.get("draft"):
            print("Draft:\n  " + top["draft"].replace("\n", "\n  "))
    print(f"Saved {args.out} and {md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
