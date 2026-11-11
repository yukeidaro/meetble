"""Hack Finder browser tools: Luma + LinkedIn, run in YOUR open Chrome (your logins).

Setup (once):
  python3 -m venv .venv && source .venv/bin/activate
  pip install 'browser-use[anthropic]'          # works with browser-use 0.13.x and 1.0.x
  export ANTHROPIC_API_KEY=sk-ant-...
  Chrome: open chrome://inspect/#remote-debugging, turn it on, click Allow when asked.
  Be logged in to luma.com and linkedin.com in that Chrome.

Usage (each prints one JSON object, so the Next.js app can call it with child_process):
  python browser_tools.py login-check                              # are Luma + LinkedIn signed in? (run first)
  python browser_tools.py luma-my-events                           # upcoming events I am registered for / hosting
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

# browser-use event limits (30 s by default) also cut off the wait for Chrome's Allow prompt. Must be set before import.
for _ev in ("TIMEOUT_BrowserStartEvent", "TIMEOUT_BrowserLaunchEvent", "TIMEOUT_BrowserConnectedEvent"):
    os.environ.setdefault(_ev, "150")

# Chrome's remote-debugging mode asks "Allow?" on every new connection, and the CDP client gives up on the
# WebSocket handshake after ~15 s. Give the person 120 s to click Allow. Patched on the class itself, so it
# applies however browser-use imported it.
try:
    import websockets.asyncio.client as _wsc
    _orig_init = _wsc.connect.__init__

    def _patient_init(self, *a, **kw):
        kw["open_timeout"] = max(float(kw.get("open_timeout") or 0), float(os.environ.get("MEETBLE_CDP_WAIT", "120")))
        return _orig_init(self, *a, **kw)

    _wsc.connect.__init__ = _patient_init
except Exception:
    pass

from browser_use import Agent, Browser, ChatAnthropic

# browser-use 0.13 also wraps connect()/reconnect() in asyncio.wait_for(..., timeout=15.0)
# (browser_use/browser/session.py). Stretch exactly those 15 s limits so Yu has time to click Allow.
import asyncio as _asyncio
_CDP_WAIT = float(os.environ.get("MEETBLE_CDP_WAIT", "120"))
_orig_wait_for = _asyncio.wait_for


async def _patient_wait_for(aw, timeout=None):
    return await _orig_wait_for(aw, timeout=_CDP_WAIT if timeout == 15.0 else timeout)


_asyncio.wait_for = _patient_wait_for

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


class SiteLogin(BaseModel):
    logged_in: bool
    account: str                       # email or display name shown for the signed-in account ("" if logged out)


class LoginStatus(BaseModel):
    luma: SiteLogin
    linkedin: SiteLogin
    x: SiteLogin
    instagram: SiteLogin


class MyLumaEvent(BaseModel):
    title: str
    url: str                           # the event page, e.g. https://luma.com/abc123
    date_time: str
    status: str                        # "Going", "Hosting", "Pending approval", "Waitlist", ...


class MyLumaEvents(BaseModel):
    events: list[MyLumaEvent]


class ActionResult(BaseModel):
    done: bool
    detail: str


# ---------- runner ----------
def your_chrome_cdp_url():
    """The DevTools URL of the Chrome you are already using (remote debugging on), so the agent runs in YOUR
    signed-in profile (your LinkedIn, Luma, X), never a fresh one. Chrome writes DevToolsActivePort when the
    chrome://inspect/#remote-debugging toggle is on."""
    if os.environ.get("MEETBLE_CDP_URL"):
        return os.environ["MEETBLE_CDP_URL"]
    local = os.environ.get("LOCALAPPDATA", "")
    home = os.path.expanduser("~")
    dirs = [os.path.join(local, "Google", "Chrome", "User Data"), os.path.join(local, "Google", "Chrome Dev", "User Data"),
            os.path.join(local, "Google", "Chrome SxS", "User Data"),
            os.path.join(home, "Library", "Application Support", "Google", "Chrome"), os.path.join(home, ".config", "google-chrome")]
    for d in dirs:
        f = os.path.join(d, "DevToolsActivePort")
        if os.path.isfile(f):
            lines = open(f, encoding="utf-8").read().split()
            if len(lines) >= 2:
                return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
    return None


def run(task: str, schema):
    cdp = your_chrome_cdp_url()
    if not cdp:
        return {"error": "Chrome remote debugging is off: open chrome://inspect/#remote-debugging, turn it on, click Allow"}
    agent = Agent(
        task,
        llm=ChatAnthropic(MODEL),
        browser=Browser(cdp_url=cdp, keep_alive=True),  # YOUR running Chrome: your cookies and logins; never closed
        output_model_schema=schema,
    )
    # No timeout= here: browser-use 0.13.x (the newest on some feeds) rejects it. The Node caller kills us after 300 s.
    history = agent.run_sync(max_steps=30)
    out = getattr(history, "structured_output", None)  # not on every browser-use version
    final = history.final_result()
    if out is None and final:
        try:
            out = schema.model_validate_json(final)
        except Exception:
            out = None
    return out.model_dump() if out is not None else {"error": "no result", "final": final}


def login_check():
    return run(
        "Check which sites I am signed in to in this browser, one by one: https://luma.com/home (Luma), "
        "https://www.linkedin.com/feed/ (LinkedIn), https://x.com/home (X), https://www.instagram.com/ (Instagram). "
        "For each, report whether I am signed in and the account email, handle or name shown (open the avatar/profile "
        "menu to read it, then close it). A login or sign-up page means signed out. "
        "Never type a password, never click Sign in or Log out.",
        LoginStatus,
    )


def luma_my_events():
    return run(
        "Open https://luma.com/home (I am signed in to Luma). List the UPCOMING events I am registered for or hosting "
        "(the 'Upcoming' tab; scroll to load all, at most 15). For each: title, the full event URL (open the event if "
        "the link is not visible), date/time, and my status (Going, Hosting, Pending approval, Waitlist). "
        "Do not register for or change anything.",
        MyLumaEvents,
    )


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
    sub.add_parser("login-check")
    sub.add_parser("luma-my-events")
    sub.add_parser("luma-check").add_argument("url")
    sub.add_parser("luma-register").add_argument("url")
    sub.add_parser("linkedin-profile").add_argument("who")
    c = sub.add_parser("linkedin-connect")
    c.add_argument("url"); c.add_argument("note"); c.add_argument("--send", action="store_true")
    a = p.parse_args()

    if a.cmd == "login-check":
        out = login_check()
    elif a.cmd == "luma-my-events":
        out = luma_my_events()
    elif a.cmd == "luma-check":
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
