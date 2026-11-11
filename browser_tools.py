"""Hack Finder browser tools: Luma + LinkedIn, run in YOUR open Chrome (your logins).

Setup (once):
  python3 -m venv .venv && source .venv/bin/activate
  pip install 'browser-use[anthropic]'          # works with browser-use 0.13.x and 1.0.x
  export ANTHROPIC_API_KEY=sk-ant-...
  Chrome: open chrome://inspect/#remote-debugging, turn it on, click Allow when asked.
  Be logged in to luma.com and linkedin.com in that Chrome.

Usage (each prints one JSON object, so the Next.js app can call it with child_process):
  python browser_tools.py cookie-check                             # fast: signed in to Luma/LinkedIn/X/Instagram? (cookies, no LLM, no tab)
  python browser_tools.py login-check                              # same answer, read by an agent (slow)
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

os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")  # browser-use phones home otherwise

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

# browser_use is imported inside run(), so cookie-check starts in well under a second.

# browser-use 0.13 also wraps connect()/reconnect() in asyncio.wait_for(..., timeout=15.0)
# (browser_use/browser/session.py). Stretch exactly those 15 s limits so Yu has time to click Allow.
import asyncio as _asyncio
_CDP_WAIT = float(os.environ.get("MEETBLE_CDP_WAIT", "120"))
_orig_wait_for = _asyncio.wait_for


async def _patient_wait_for(aw, timeout=None):
    return await _orig_wait_for(aw, timeout=_CDP_WAIT if timeout == 15.0 else timeout)


_asyncio.wait_for = _patient_wait_for

# claude-sonnet-5-5 rejects browser-use's forced tool_choice (400); haiku-5-5 works (live, 2026-11-11).
MODEL = os.environ.get("HF_BROWSER_MODEL", "claude-haiku-5-5")


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


# A site counts as signed in when its session cookie is in your Chrome (and not expired). Same rules as server.mjs.
SESSION_COOKIES = {
    "luma": (("luma.com", "lu.ma"), lambda n: "auth" in n.lower()),          # luma.auth-session-key
    "linkedin": (("linkedin.com",), lambda n: n == "li_at"),
    "x": (("x.com", "twitter.com"), lambda n: n == "auth_token"),
    "instagram": (("instagram.com",), lambda n: n == "sessionid"),
}


def cookie_check():
    """Which sites are signed in, read from your Chrome's cookies over one CDP call: no agent, no tab opened,
    one Allow click. Prints the same shape as login-check."""
    cdp = your_chrome_cdp_url()
    if not cdp:
        return {"error": "Chrome remote debugging is off: open chrome://inspect/#remote-debugging, turn it on, click Allow"}
    from websockets.sync.client import connect
    try:
        with connect(cdp, open_timeout=_CDP_WAIT, max_size=None) as ws:
            ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
            while True:
                msg = json.loads(ws.recv(timeout=30))
                if msg.get("id") == 1:
                    break
    except TimeoutError:
        return {"error": "Chrome did not answer: click Allow on Chrome's remote-debugging prompt, then try again"}
    except OSError as e:
        return {"error": f"Chrome is not reachable (is it open with remote debugging on?): {e}"}
    if "error" in msg:
        return {"error": f"Chrome refused the cookie read: {msg['error'].get('message', msg['error'])}"}
    return _sites_from_cookies(msg["result"]["cookies"])


def _agent_kwargs(browser, schema):
    from browser_use import ChatAnthropic
    return dict(llm=ChatAnthropic(MODEL), browser=browser, output_model_schema=schema)


def _make_agent(task: str, schema, browser):
    from browser_use import Agent
    kw = _agent_kwargs(browser, schema)
    # browser-use takes over the first open tab, which is often the Meetble page, and then there is no way back.
    # Start the agent in a tab of its own instead.
    task = "Work only in the tab you start in; never switch to or navigate other tabs. " + task
    for extra in (dict(use_judge=False, initial_actions=[{"navigate": {"url": "about:blank", "new_tab": True}}]),
                  dict(initial_actions=[{"navigate": {"url": "about:blank", "new_tab": True}}]), {}):
        # use_judge=False: browser-use otherwise spends one more LLM call grading each run. Older versions lack
        # use_judge or initial_actions, so fall back step by step.
        try:
            return Agent(task, **extra, **kw)
        except TypeError:
            continue
    raise RuntimeError("unsupported browser-use version")


def _result(history, schema):
    out = getattr(history, "structured_output", None)  # not on every browser-use version
    final = history.final_result()
    if out is None and final:
        try:
            out = schema.model_validate_json(final)
        except Exception:
            out = None
    return out.model_dump() if out is not None else {"error": "no result", "final": final}


def run(task: str, schema):
    """One-shot: a new connection to your Chrome for this one task (one Allow click). See serve() for the
    long-lived worker that keeps the connection open across tasks."""
    from browser_use import Browser
    cdp = your_chrome_cdp_url()
    if not cdp:
        return {"error": OFF}
    agent = _make_agent(task, schema, Browser(cdp_url=cdp, keep_alive=True))  # YOUR running Chrome; never closed
    # No timeout= here: browser-use 0.13.x (the newest on some feeds) rejects it. The Node caller kills us after 300 s.
    return _result(agent.run_sync(max_steps=30), schema)


OFF = "Chrome remote debugging is off: open chrome://inspect/#remote-debugging, turn it on, click Allow"


# ---------- the tasks (each returns (task, schema), or a finished result dict) ----------
def job(cmd, args):
    if cmd == "login-check":
        return (
            "Check which sites I am signed in to in this browser, one by one: https://luma.com/home (Luma), "
            "https://www.linkedin.com/feed/ (LinkedIn), https://x.com/home (X), https://www.instagram.com/ (Instagram). "
            "For each, report whether I am signed in and the account email, handle or name shown (open the avatar/profile "
            "menu to read it, then close it). A login or sign-up page means signed out. "
            "Never type a password, never click Sign in or Log out.",
            LoginStatus,
        )
    if cmd == "luma-my-events":
        return (
            "Open https://luma.com/home (I am signed in to Luma). List the UPCOMING events I am registered for or hosting "
            "(the 'Upcoming' tab; scroll to load all, at most 15). For each: title, the full event URL (open the event if "
            "the link is not visible), date/time, and my status (Going, Hosting, Pending approval, Waitlist). "
            "Do not register for or change anything.",
            MyLumaEvents,
        )
    if cmd == "luma-check":
        (url,) = args
        return (
            f"Open {url}. I am already logged in to Luma. Read the event page and report: title, date/time, "
            "location, hosts, whether I am registered and my status, the guest count, and the names on the "
            "guest list if Luma shows it (click 'See all' / the guest avatars to open it; scroll to load all). "
            "Do not click Register or change anything.",
            LumaEvent,
        )
    if cmd == "luma-register":
        (url,) = args
        return (
            f"Open {url}. I am logged in to Luma. If I am not registered yet, click the register / request-to-join "
            "button and complete the form using my account's prefilled details. If a required question has no "
            "obvious answer, stop and report the question instead of guessing. If already registered, change nothing. "
            "Report whether I am registered at the end and my status.",
            ActionResult,
        )
    if cmd == "linkedin-profile":
        (who,) = args
        target = who if who.startswith("http") else f"the LinkedIn profile of '{who}' (use LinkedIn search, pick the best match)"
        return (
            f"Using LinkedIn (I am logged in), open {target}. Report: profile URL, name, headline, current role, "
            "location, connection degree, the names of mutual connections (click the 'mutual connections' link and "
            "list up to 20), the last 5 posts or comments from their Activity section (one line each), and which "
            "contact button is available (Message / Connect / Follow). Do not click Connect, Follow or Message.",
            LinkedInProfile,
        )
    if cmd == "linkedin-connect":
        url, note, send = args
        if not send:
            return {"done": False, "detail": f"DRY RUN. Would send connection request to {url} with note: {note!r}. Add --send to send."}
        return (
            f"Open {url} on LinkedIn (I am logged in). Send a connection request with this exact note "
            f"(Connect may be under 'More'; choose 'Add a note'): {note!r}. If the note exceeds LinkedIn's limit, "
            "stop and report. Report whether it was sent.",
            ActionResult,
        )
    raise ValueError(f"unknown command {cmd}")


def _run_job(cmd, args):
    j = job(cmd, args)
    return j if isinstance(j, dict) else run(*j)


def login_check():
    return _run_job("login-check", [])


def luma_my_events():
    return _run_job("luma-my-events", [])


def luma_check(url):
    return _run_job("luma-check", [url])


def luma_register(url):
    return _run_job("luma-register", [url])


def linkedin_profile(who):
    return _run_job("linkedin-profile", [who])


def linkedin_connect(url, note, send):
    return _run_job("linkedin-connect", [url, note, send])


# ---------- long-lived worker: one connection to your Chrome for the whole session ----------
# Chrome asks "Allow?" for every new remote-debugging connection. The one-shot commands above open a new one
# per call (a click for the sign-in check, another for your Luma events, another for LinkedIn...). serve() keeps
# its connections open, so you click Allow once (twice if two browser tasks ever run at the same time).
#
# Protocol: newline-delimited JSON over 127.0.0.1 TCP. Each request carries the token from MEETBLE_WORKER_TOKEN:
#   {"token": "...", "id": 1, "cmd": "linkedin-profile", "args": ["Boris Jabes"]}  -> {"id": 1, "result": {...}}
#   {"token": "...", "id": 2, "cancel": 1}                                         -> stops request 1
def _sites_from_cookies(cookies, now=None):
    import time
    now = time.time() if now is None else now
    out = {}
    for site, (domains, is_session) in SESSION_COOKIES.items():
        hit = [c for c in cookies
               if any(c["domain"].lstrip(".") == d or c["domain"].endswith("." + d) for d in domains)
               and is_session(c["name"]) and c.get("value") and (c.get("session") or c.get("expires", -1) <= 0 or c["expires"] > now)]
        out[site] = {"logged_in": bool(hit), "account": ""}
    return out


class Pool:
    """Up to `size` browser-use sessions on your Chrome, each made (and Allowed) once, then reused."""

    def __init__(self, size):
        self.size, self.made, self.idle = size, [], _asyncio.Queue()

    async def take(self):
        if self.idle.empty() and len(self.made) < self.size:
            from browser_use import Browser
            cdp = your_chrome_cdp_url()
            if not cdp:
                raise RuntimeError(OFF)
            b = Browser(cdp_url=cdp, keep_alive=True)
            try:
                await b.start()  # the one Allow click for this session
            except Exception as e:
                raise RuntimeError(f"Chrome is not reachable or Allow was not clicked: {str(e)[:120]}")
            self.made.append(b)
            return b
        return await self.idle.get()

    def give(self, b, broken=False):
        if broken:
            if b in self.made:
                self.made.remove(b)
            return
        self.idle.put_nowait(b)


async def _cookies_via(pool):
    b = await pool.take()
    try:
        r = await b.cdp_client.send.Storage.getCookies()
    except Exception as e:
        pool.give(b, broken=True)
        return {"error": f"Chrome refused the cookie read: {str(e)[:120]}"}
    pool.give(b)
    return _sites_from_cookies(r.get("cookies", []))


async def _job_via(pool, cmd, args):
    if cmd == "cookie-check":
        return await _cookies_via(pool)
    j = job(cmd, args)
    if isinstance(j, dict):
        return j
    task, schema = j
    b = await pool.take()
    agent, broken = None, False
    try:
        agent = _make_agent(task, schema, b)
        return _result(await agent.run(max_steps=30), schema)
    except _asyncio.CancelledError:
        # Over the time budget: stop the agent but keep the connection (every task starts in a new tab),
        # so the next task needs no new Allow click.
        try:
            await _asyncio.shield(agent.close()) if agent else None
        except BaseException:
            pass
        raise
    except Exception:
        broken = True  # the connection itself may be gone: the next task opens a fresh one
        raise
    finally:
        pool.give(b, broken)


async def serve(port, size, exit_on_eof):
    import asyncio
    token = os.environ.get("MEETBLE_WORKER_TOKEN", "")
    if not token:
        print(json.dumps({"error": "MEETBLE_WORKER_TOKEN is not set"}), flush=True)
        return 2
    pool = Pool(size)

    async def handle(reader, writer):
        tasks = {}
        lock = asyncio.Lock()

        async def reply(obj):
            async with lock:
                writer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
                await writer.drain()

        async def one(rid, cmd, args):
            try:
                res = await _job_via(pool, cmd, args)
            except asyncio.CancelledError:
                res = {"error": "cancelled"}
            except Exception as e:
                res = {"error": str(e)[:300]}
            tasks.pop(rid, None)
            try:
                await reply({"id": rid, "result": res})
            except Exception:
                pass

        try:
            while line := await reader.readline():
                try:
                    m = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(m, dict) or m.get("token") != token:
                    await reply({"id": m.get("id") if isinstance(m, dict) else None, "result": {"error": "bad token"}})
                    continue
                if "cancel" in m:
                    t = tasks.get(m["cancel"])
                    if t:
                        t.cancel()
                    continue
                rid = m.get("id")
                tasks[rid] = asyncio.create_task(one(rid, str(m.get("cmd")), list(m.get("args") or [])))
        finally:
            for t in tasks.values():  # the caller went away: stop its tasks
                t.cancel()
            writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", port)
    print(json.dumps({"listening": server.sockets[0].getsockname()[1]}), flush=True)
    if exit_on_eof:  # spawned by a Node process: stop when it exits (its end of our stdin closes)
        await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)
        server.close()  # don't wait for open connections (wait_closed would): asyncio.run cancels their tasks
        return 0
    await server.serve_forever()
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login-check")
    sub.add_parser("cookie-check")
    sv = sub.add_parser("serve")  # long-lived worker; see serve()
    sv.add_argument("--port", type=int, default=0)
    sv.add_argument("--tabs", type=int, default=int(os.environ.get("MEETBLE_BROWSER_TABS", "2")))
    sv.add_argument("--exit-on-stdin-eof", action="store_true")
    sub.add_parser("luma-my-events")
    sub.add_parser("luma-check").add_argument("url")
    sub.add_parser("luma-register").add_argument("url")
    sub.add_parser("linkedin-profile").add_argument("who")
    c = sub.add_parser("linkedin-connect")
    c.add_argument("url"); c.add_argument("note"); c.add_argument("--send", action="store_true")
    a = p.parse_args()

    if a.cmd == "serve":
        return _asyncio.run(serve(a.port, max(1, a.tabs), a.exit_on_stdin_eof))
    if a.cmd == "cookie-check":
        out = cookie_check()
    elif a.cmd == "login-check":
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
