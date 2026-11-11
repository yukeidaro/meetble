"""Hack Finder browser tools: Luma + LinkedIn, run in YOUR open Chrome (your logins).

Setup (once):
  python3 -m venv .venv && source .venv/bin/activate
  pip install 'browser-use[anthropic]'          # tested with browser-use 1.0.2
  export ANTHROPIC_API_KEY=sk-ant-...
  Chrome: open chrome://inspect/#remote-debugging, turn it on, click Allow when asked.
  Be logged in to luma.com and linkedin.com in that Chrome.

Usage (each prints one JSON object, so the Next.js app can call it with child_process):
  python browser_tools.py luma-check   https://luma.com/compiled-poy7
  python browser_tools.py luma-register https://luma.com/compiled-poy7
  python browser_tools.py linkedin-profile "Boris Jabes"           # or a linkedin.com/in/... URL
  python browser_tools.py linkedin-connect https://www.linkedin.com/in/... "note text"          # dry run
  python browser_tools.py linkedin-connect https://www.linkedin.com/in/... "note text" --send   # really sends
"""
import argparse
import json
import os
import sys

from pydantic import BaseModel
from browser_use import Agent, Browser, ChatAnthropic

MODEL = os.environ.get("HF_BROWSER_MODEL", "claude-sonnet-5-5")


# ---------- output schemas ----------
class LumaEvent(BaseModel):
    title: str
    date_time: str
    location: str
    hosts: list[str]
    i_am_registered: bool
    registration_status: str          # e.g. "Going", "Pending approval", "Not registered", "Waitlist"
    guest_count: int | None
    visible_guests: list[str]          # names shown on the public guest list (empty if hidden)
    notes: str


class LinkedInProfile(BaseModel):
    profile_url: str
    name: str
    headline: str
    current_role: str
    location: str
    connection_degree: str             # "1st", "2nd", "3rd", "Out of network"
    mutual_connections: list[str]      # names LinkedIn shows as shared connections
    recent_activity: list[str]         # last few posts/comments, one line each
    accepts_messages: str              # "Message button", "Connect only", "Follow only", "InMail only"
    notes: str


class ActionResult(BaseModel):
    done: bool
    detail: str


# ---------- runner ----------
def run(task: str, schema):
    agent = Agent(
        task,
        llm=ChatAnthropic(MODEL),
        browser=Browser("chrome"),   # attaches to your open Chrome: your cookies, your logins
        output_model_schema=schema,
    )
    history = agent.run_sync(max_steps=30, timeout=300)
    out = history.structured_output
    return out.model_dump() if out is not None else {"error": "no result", "final": history.final_result()}


def luma_check(url):
    return run(
        f"Open {url}. I am already logged in to Luma. Read the event page and report: title, date/time, "
        "location, hosts, whether I am registered and my status, the guest count, and the names on the "
        "guest list if Luma shows it (click 'See all' / the guest avatars to open it; scroll to load all). "
        "Do not click Register or change anything.",
        LumaEvent,
    )


def luma_register(url):
    return run(
        f"Open {url}. I am logged in to Luma. If I am not registered yet, click the register / request-to-join "
        "button and complete the form using my account's prefilled details. If a required question has no "
        "obvious answer, stop and report the question instead of guessing. If already registered, change nothing. "
        "Report whether I am registered at the end and my status.",
        ActionResult,
    )


def linkedin_profile(who):
    target = who if who.startswith("http") else f"the LinkedIn profile of '{who}' (use LinkedIn search, pick the best match)"
    return run(
        f"Using LinkedIn (I am logged in), open {target}. Report: profile URL, name, headline, current role, "
        "location, connection degree, the names of mutual connections (click the 'mutual connections' link and "
        "list up to 20), the last 5 posts or comments from their Activity section (one line each), and which "
        "contact button is available (Message / Connect / Follow). Do not click Connect, Follow or Message.",
        LinkedInProfile,
    )


def linkedin_connect(url, note, send):
    if not send:
        return {"done": False, "detail": f"DRY RUN. Would send connection request to {url} with note: {note!r}. Add --send to send."}
    return run(
        f"Open {url} on LinkedIn (I am logged in). Send a connection request with this exact note "
        f"(Connect may be under 'More'; choose 'Add a note'): {note!r}. If the note exceeds LinkedIn's limit, "
        "stop and report. Report whether it was sent.",
        ActionResult,
    )


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("luma-check").add_argument("url")
    sub.add_parser("luma-register").add_argument("url")
    sub.add_parser("linkedin-profile").add_argument("who")
    c = sub.add_parser("linkedin-connect")
    c.add_argument("url"); c.add_argument("note"); c.add_argument("--send", action="store_true")
    a = p.parse_args()

    if a.cmd == "luma-check":
        out = luma_check(a.url)
    elif a.cmd == "luma-register":
        out = luma_register(a.url)
    elif a.cmd == "linkedin-profile":
        out = linkedin_profile(a.who)
    else:
        out = linkedin_connect(a.url, a.note, a.send)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
