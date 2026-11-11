// Meetble local server: serves the UI and runs the real pipeline behind it. Zero dependencies.
//   node server.mjs            -> http://localhost:8787
//   PORT=9000 node server.mjs  (PowerShell: $env:PORT=9000; node server.mjs)
// Steps 0-2: node dist/cli.js ...  -> out/research.json
// Steps 3-5: python -m plan ...     -> out/plan.json, out/plan.md
// Each stdout checklist line ("ICON label (note)") becomes a UI event, streamed to the browser over SSE.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1"; // HOST=0.0.0.0 on a cloud server (GMI)
const TOKEN = process.env.MEETBLE_TOKEN || ""; // when set, every /api call except health needs ?token=... (keeps strangers off your API keys)
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const OUT = join(ROOT, "out");
const RESEARCH = join(OUT, "research.json");
const PLAN = join(OUT, "plan.json");

// ---------- the ask: "Meet Boris Jabes before 22:45 tonight, in person. Budget ¥30,000." ----------
const ymd = (d) => d.toLocaleDateString("en-CA"); // local YYYY-MM-DD
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseAsk(text, now = new Date()) {
  const t = String(text || "").trim();
  let name = (t.match(/\b(?:[Mm]eet|[Rr]each|[Tt]alk to|[Cc]ontact|[Gg]et to)\s+((?:[A-Z][\p{L}.'-]*\s*){1,4})/u)?.[1] || "").trim();
  if (!name) name = (t.match(/(?:[A-Z][\p{L}.'-]+\s+){1,3}[A-Z][\p{L}.'-]+/u)?.[0] || "").trim();
  if (!name && t.split(/\s+/).length <= 4) name = t.replace(/[.,!?]+$/, "");
  name = name.replace(/\s+(Before|By|Tonight|Today|Tomorrow|In|On|At|This|Next)$/, "").trim();

  let deadline, label;
  const add = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
  const iso = t.match(/\b(20\d\d-\d\d-\d\d)\b/);
  const inN = t.match(/\bin\s+(\d+)\s+days?\b/i);
  const wd = DAYS.findIndex((d) => new RegExp(`\\b${d}\\b`, "i").test(t));
  if (iso) { deadline = iso[1]; label = iso[1]; }
  else if (/\b(tonight|today)\b/i.test(t)) { deadline = ymd(now); label = "tonight"; }
  else if (/\btomorrow\b/i.test(t)) { deadline = ymd(add(1)); label = "tomorrow"; }
  else if (inN) { deadline = ymd(add(+inN[1])); label = `in ${inN[1]} days`; }
  else if (/\bnext week\b/i.test(t)) { deadline = ymd(add(7)); label = "next week"; }
  else if (/\b(this week|end of (the )?week)\b/i.test(t)) { deadline = ymd(add((5 - now.getDay() + 7) % 7 || 7)); label = "this week"; }
  else if (wd >= 0) { deadline = ymd(add((wd - now.getDay() + 7) % 7 || 7)); label = DAYS[wd][0].toUpperCase() + DAYS[wd].slice(1); }
  else { deadline = ymd(add(7)); label = "in a week"; }
  const time = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)?.[0];
  if (time && label === "tonight") label = `${time} tonight`;

  const yen = t.match(/[¥￥]\s?([\d,]+)/) || t.match(/([\d,]+)\s?(?:yen|jpy|円)/i);
  const usd = t.match(/\$\s?([\d,]+)/);
  const budget_jpy = yen ? +yen[1].replace(/,/g, "") : usd ? +usd[1].replace(/,/g, "") * 150 : undefined;
  const meet = /in person|face|coffee|hello/i.test(t) ? "in-person meeting" : /\bcall\b/i.test(t) ? "15-min call" : /\breply\b/i.test(t) ? "reply" : "reply, call or in-person meeting";
  return { name, deadline, deadline_label: label, budget_jpy, meet };
}

// ---------- stdout checklist line -> step ----------
const ICONS = [["[..]", "running"], ["[ok]", "done"], ["[x]", "error"], ["[--]", "skipped"], ["⏳", "running"], ["✅", "done"], ["❌", "error"], ["⏭️", "skipped"], ["⏭", "skipped"]];

export function parseLine(raw) {
  let s = raw.trim(), status;
  if (s.startsWith("[") && !s.startsWith("[..]") && !s.startsWith("[ok]") && !s.startsWith("[x]") && !s.startsWith("[--]")) {
    const m = s.match(/^\[([^\]]+)\]\s*(.*)$/u); // python: "[✅] Step 3 · label (note)"
    if (!m) return null;
    status = ICONS.find(([i]) => i === m[1] || i.startsWith(m[1]) || m[1].startsWith(i))?.[1];
    s = m[2];
  } else {
    const hit = ICONS.find(([i]) => s.startsWith(i));
    if (!hit) return null;
    status = hit[1]; s = s.slice(hit[0].length).replace(/^️/, "").trim();
  }
  if (!status) return null;
  let step;
  const st = s.match(/^Step\s+(\S+)\s+·\s+(.*)$/u);
  if (st) { step = st[1]; s = st[2]; }
  let label = s, note = "";
  if (s.endsWith(")")) { // last balanced "( ... )" is the note
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === ")") depth++;
      else if (s[i] === "(" && --depth === 0) { if (s[i - 1] === " ") { label = s.slice(0, i - 1); note = s.slice(i + 1, -1); } break; }
    }
  }
  return { status, step, label: label.trim(), note };
}

const G = { 0: "Step 0 · Who", 1: "Step 1 · What they want", 2: "Step 2 · Right now", 3: "Step 3 · Needs", 4: "Step 4 · Interview", 5: "Step 5 · Plan" };
function researchGroup(label) {
  if (/signed in|Re-checking sign|Luma events|^Identifying|X account|Sign in/i.test(label)) return G[0];
  if (/this week|events .* joins|booking page/i.test(label)) return G[2];
  return G[1];
}
function domainOf(label) {
  if (/podcast|talks/i.test(label)) return ["youtube.com", "Searching podcasts and talks"];
  if (/LinkedIn/i.test(label)) return ["linkedin.com", label];
  if (/Luma/i.test(label)) return ["luma.com", label];
  if (/Instagram/i.test(label)) return ["instagram.com", label];
  if (/\bX\b/.test(label)) return ["x.com", label];
  if (/booking/i.test(label)) return ["calendly.com", label];
  if (/email/i.test(label)) return ["mail domain lookup", label];
  if (/news/i.test(label)) return ["exa.ai", label];
  if (/needs|want\b|^Rank|^Interview you|^Load research|Claude API/i.test(label) && !/bio/i.test(label)) return ["reasoning", label];
  return ["exa.ai", label];
}
const sid = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h.toString(36); };

// ---------- research.json / plan.json -> UI events ----------
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const DIM_LABEL = { web: "Web", podcast: "Talks about", x: "X", linkedin: "LinkedIn", instagram: "Instagram", email: "Email" };

// "2025-05" / "2026-11-09" / "2026-11-11T22:45" -> { date: "May 2025" | "Nov 9" | "Today · 22:45", ts: 202611112245 } for the timeline
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateOf(iso, now = new Date()) {
  const m = String(iso || "").match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return {};
  const [y, mo, d, hh, mm] = m.slice(1).map((v) => (v === undefined ? undefined : +v));
  const ts = y * 1e8 + (mo || 1) * 1e6 + (d || 1) * 1e4 + (hh || 0) * 100 + (mm || 0);
  const time = hh === undefined ? "" : ` · ${m[4]}:${m[5]}`;
  let date = String(y);
  if (mo && !d) date = `${MON[mo - 1]} ${y}`;
  else if (d) date = y === now.getFullYear() && mo === now.getMonth() + 1 && d === now.getDate() ? `Today${time}` : `${MON[mo - 1]} ${d}${y === now.getFullYear() ? "" : `, ${y}`}${time}`;
  return { date, ts };
}

// Niche details: his own words and other specifics only a deep dig finds, each with a hint on how to use it.
const THEME = {
  looking_for: ["Looking for", "Lead with this: it's what he says he wants.", 1],
  frustrates: ["Pet peeve", "Avoid this, and say that you did.", 2],
  excites: ["Lights him up", "Open on this topic.", 3],
  repeated_story: ["Story he retells", "Reference it to show you listened.", 4],
  other: ["In his words", "Quote it back in your first line.", 5],
};
function nicheOf(f) {
  const d = f.data || {};
  if (f.kind === "quote") {
    const [label, use, rank] = THEME[d.theme] || THEME.other;
    return { label, use, rank, depth: d.episode ? `Transcript: ${String(d.episode).slice(0, 70)}` : "Transcript" };
  }
  if (f.kind === "mutuals") return { label: "Mutual connections", use: "Ask the closest one for a two-line intro.", rank: 6, depth: "Your LinkedIn, signed in" };
  if (f.kind === "inner_circle") return { label: "Inner circle", use: "Warm path: get this person to introduce you.", rank: 7, depth: "His replies, last 60 days" };
  if (f.kind === "post") return { label: "Recent post", use: "Reply with one concrete point today.", rank: 8, depth: f.dimension === "linkedin" ? "His LinkedIn activity" : "His X timeline" };
  if (f.kind === "email") return { label: "Work email", use: "Send the value-first email here.", rank: 9, depth: "Address pattern check" };
  return null;
}

function findingEvents(research) {
  const evs = [], per = { persona: 0, niche: 0, now: 0, prec: 0 };
  for (const f of research.findings || []) {
    const dim = f.dimension || "web";
    const niche = nicheOf(f);
    const section = niche ? "niche" : dim === "precedent" ? "prec" : f.step === 2 || ["mention", "event", "booking"].includes(dim) ? "now" : "persona";
    if (per[section]++ >= 14) continue;
    const label = niche ? niche.label : section === "persona" ? (f.kind === "bio" ? "Role" : DIM_LABEL[dim] || "") : "";
    const when = section === "persona" ? {} : dateOf(f.date);
    const claim = niche ? (f.kind === "quote" && f.quote ? `“${String(f.quote).slice(0, 220)}”` : f.claim)
      : f.quote ? `${f.claim} “${String(f.quote).slice(0, 160)}”` : f.claim;
    evs.push({ type: "finding", section, label, ...when, ...(niche ? { use: niche.use, depth: niche.depth, rank: niche.rank } : {}), claim, source_url: f.source_url });
  }
  return evs;
}

const OUT_OF = { event: "face", network_first: "face", referral: "call", paid_intro: "call", booking_page: "call", paid_consult: "call" };
function toUiAction(a) {
  const url = a.channel_url || "", draft = a.draft || "";
  const acct = /linkedin\.com/i.test(url) ? "linkedin" : /(^|\/\/|\.)x\.com|twitter\.com/i.test(url) ? "x" : /lu\.ma|luma\.com/i.test(url) ? "luma" : null;
  const r = a.reasons || {};
  const whyDo = [r.m_relevance, r.m_warmth, r.m_timing, r.m_channel, r.base_rate].filter(Boolean).slice(0, 4);
  if (a.provisional) whyDo.unshift("Found live during research; re-ranked when research ends");
  whyDo.push(`${a.cost_jpy == null ? "price not checked yet" : `¥${Number(a.cost_jpy).toLocaleString()}`} · ${a.hours}h of your time · ${a.days_to_outcome} day(s) to a result`);
  const inTotal = a.in_total ?? (a.fits_deadline !== false && a.fits_budget !== false);
  return {
    id: a.id, type: a.type, kind: draft || url ? "agent" : "you", out: OUT_OF[a.type] || "reply",
    title: a.title, base: a.p, rel: 1, time: 1, warm: 1, chan: 1, // the % is computed in Python; pass it through as-is
    late: !inTotal, lateText: a.fits_deadline === false ? "Too slow for the deadline" : "Over budget",
    cta: draft && url ? "Copy draft & open" : draft ? "Copy the draft" : url ? "Open the link" : "Add to my plan",
    doWhat: (a.how || []).join(" → ") || a.title, draft, url, acct,
    doneNote: draft || url ? "" : "on your plan", whyDo, how: a.how || [], cost: a.cost_jpy, hours: a.hours, days: a.days_to_outcome,
  };
}

// ---------- jobs ----------
let job = null;

function startJob(body) {
  if (job && !job.done) stopJob();
  const ask = parseAsk(body.ask);
  if (body.name) ask.name = String(body.name).trim();
  const j = { id: Date.now().toString(36), events: [], clients: new Set(), done: false, child: null, ask, live: [], nonce: randomBytes(9).toString("hex") };
  job = j;
  const push = (ev) => {
    if (job !== j) return;
    j.events.push(ev);
    for (const c of j.clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
    // Close the streams after "end": clients that don't close on their own (curl, proxies) would otherwise hang.
    if (ev.type === "end") { for (const c of j.clients) c.end(); j.clients.clear(); }
  };
  j.push = push;
  run(j, body).catch((e) => push({ type: "step", id: "fatal", group: G[0], label: "The run stopped", status: "none", note: String(e?.message || e).slice(0, 200) }))
    .finally(() => { j.done = true; push({ type: "end" }); });
  return j;
}

function stopJob() {
  if (!job) return;
  try { job.child?.kill(); } catch {}
  job.done = true;
}

// ---------- one long-lived browser worker for the whole server (src/tools/browser_worker.ts) ----------
// Chrome asks "Allow?" for each new remote-debugging connection. Research runs reuse this worker's connection, so
// you click Allow when the first run needs the browser, not again on every run. MEETBLE_BROWSER_WORKER=0 turns it off.
let worker = null; // Promise<{ MEETBLE_BROWSER_WORKER, MEETBLE_WORKER_TOKEN } | {}>
function browserPython() {
  if (process.env.BROWSER_PYTHON) return process.env.BROWSER_PYTHON;
  return [join(ROOT, ".venv", "Scripts", "python.exe"), join(ROOT, ".venv", "bin", "python")].find((p) => existsSync(p));
}
function browserWorkerEnv() {
  if (["0", "off"].includes(process.env.MEETBLE_BROWSER_WORKER || "") || process.env.MEETBLE_BROWSER === "0") return Promise.resolve({});
  if (worker) return worker;
  const py = browserPython();
  if (!py || !existsSync(join(ROOT, "browser_tools.py"))) return Promise.resolve({});
  const token = randomBytes(18).toString("hex");
  worker = new Promise((resolve) => {
    const p = spawn(py, [join(ROOT, "browser_tools.py"), "serve", "--exit-on-stdin-eof"], { cwd: ROOT, env: { ...process.env, MEETBLE_WORKER_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({}); }, 30_000);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      out += d;
      const m = /\{"listening":\s*(\d+)\}/.exec(out);
      if (m) { clearTimeout(t); resolve({ MEETBLE_BROWSER_WORKER: `127.0.0.1:${m[1]}`, MEETBLE_WORKER_TOKEN: token }); out = ""; }
    });
    p.stderr.on("data", (d) => process.stderr.write(d));
    const gone = () => { clearTimeout(t); worker = null; resolve({}); }; // next run starts a new one
    p.on("error", gone);
    p.on("exit", gone);
  });
  return worker;
}

function runProc(j, cmd, args, env, onLine) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    j.child = p;
    const err = [];
    let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); process.stdout.write(d); });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => { err.push(d); process.stderr.write(d); });
    p.on("error", (e) => { err.push(String(e.message)); resolve({ code: -1, err: err.join("") }); });
    p.on("close", (code) => { if (buf) onLine(buf); resolve({ code, err: err.join("") }); });
  });
}

function stepHandler(j, groupFor) {
  const seen = new Set();
  let signIn = false;
  return (line) => {
    if (j.done) return;
    if (/Please sign in yourself/i.test(line)) { signIn = true; return; }
    if (signIn && /^\s+-\s/.test(line)) {
      const t = line.replace(/^\s+-\s/, "");
      j.push({ type: "step", id: "si" + sid(t), group: G[0], label: "Sign in needed in your Chrome", status: "locked", note: t });
      return;
    }
    // A live action card from research (src/leads.ts): show it now, Step 5 re-ranks later. Only lines carrying this
    // run's nonce count, so text from a web page that ends up in a checklist note can't forge a card.
    const tag = `ACTION:${j.nonce} `;
    if (line.startsWith(tag)) {
      try { const a = JSON.parse(line.slice(tag.length)); j.live.push(a); j.push({ type: "action", action: toUiAction(a) }); } catch {}
      return;
    }
    const s = parseLine(line);
    if (!s) { if (line.trim()) j.push({ type: "log", text: line.trim() }); return; }
    if (s.step === "5" && /^\s*[\d.<>]+%/.test(s.label)) return; // per-action lines: the deck shows these
    const group = s.step ? (G[s.step] || G[5]) : groupFor(s.label);
    const id = "s" + sid(group + s.label);
    const status = s.status === "running" ? "running" : s.status === "done" ? "done" : "none";
    const note = s.status === "error" ? `error: ${s.note}` : s.note;
    j.push({ type: "step", id, group, label: s.label, status, note });
    if (s.status === "running" && !seen.has(id)) { seen.add(id); const [domain, action] = domainOf(s.label); j.push({ type: "browse", domain, action, url: domain }); }
  };
}

async function run(j, body) {
  const { push, ask } = j;
  push({ type: "meta", name: ask.name, deadline: ask.deadline, deadline_label: ask.deadline_label, budget_jpy: ask.budget_jpy });
  if (!ask.name) throw new Error("Couldn't find a name in that. Try: Meet Boris Jabes before Friday");

  // Steps 0-2
  const reuse = body.reuse && existsSync(RESEARCH);
  if (reuse) {
    push({ type: "step", id: "reuse", group: G[0], label: "Reused the last research run", status: "done", note: "out/research.json" });
  } else {
    if (!existsSync(join(ROOT, "dist", "cli.js"))) throw new Error("dist/cli.js is missing. Run: npm install, then npm run build");
    const args = [join(ROOT, "dist", "cli.js"), ask.name, "--deadline", ask.deadline, "--out", RESEARCH];
    if (body.hint) args.push("--hint", String(body.hint));
    if (body.x_handle) args.push("--x-handle", String(body.x_handle).replace(/^@/, ""));
    for (const u of [].concat(body.event_urls || []).filter(Boolean)) args.push("--event-url", String(u));
    const r = await runProc(j, process.execPath, args, { MEETBLE_ACTION_NONCE: j.nonce, ...(await browserWorkerEnv()) }, stepHandler(j, researchGroup));
    if (j.done) return;
    if (r.code !== 0 || !existsSync(RESEARCH)) throw new Error(`Research failed (exit ${r.code}): ${r.err.trim().split("\n").pop() || "no output"}`);
  }
  const research = JSON.parse(readFileSync(RESEARCH, "utf8").replace(/^﻿/, ""));
  const t = research.target_id || {};
  push({ type: "meta", name: t.name || ask.name, role: [t.role, t.company].filter(Boolean).join(" · ") });
  for (const ev of findingEvents(research)) push(ev);
  if (reuse) for (const a of research.live_actions || []) { j.live.push(a); push({ type: "action", action: toUiAction(a) }); }
  // If Steps 3-5 fail, the live cards found during research are still a usable plan (root cause #4: one big final call).
  const fallback = (why) => {
    if (!j.live.length) throw new Error(why);
    push({ type: "step", id: "s5fallback", group: G[5], label: "Ranking didn't finish; showing the actions found during research", status: "none", note: why.slice(0, 160) });
    push({ type: "actions", actions: j.live.map(toUiAction), p_total: null, summary: "" });
  };

  // Steps 3-5
  research.goal = { ...(research.goal || {}), meet: ask.meet, ...(ask.budget_jpy ? { budget_jpy: ask.budget_jpy } : {}) };
  writeFileSync(RESEARCH, JSON.stringify(research, null, 2), "utf8");
  const pargs = ["-m", "plan", RESEARCH, "--out", PLAN, "--no-interview"];
  if (existsSync(join(ROOT, "user_profile.json"))) pargs.push("--profile", join(ROOT, "user_profile.json"));
  const mtime = () => (existsSync(PLAN) ? statSync(PLAN).mtimeMs : 0), before = mtime();
  // Steps 3-5 get a hard limit (MEETBLE_PLAN_TIMEOUT_S, default 240 s); past it, the live cards stand in.
  const planMs = (Number(process.env.MEETBLE_PLAN_TIMEOUT_S) || 240) * 1000;
  let planTimedOut = false;
  const planTimer = setTimeout(() => { planTimedOut = true; try { j.child?.kill(); } catch {} }, planMs);
  const r = await runProc(j, PY, pargs, { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, stepHandler(j, () => G[5]));
  clearTimeout(planTimer);
  if (planTimedOut && !j.done) return fallback(`Steps 3-5 took longer than ${planMs / 1000} s and were stopped`);
  if (j.done) return;
  const planText = mtime() > before ? readFileSync(PLAN, "utf8") : null;
  if (!planText) return fallback(`Planning failed (exit ${r.code}): ${r.err.trim().split("\n").pop() || "no plan written"}`);
  let plan;
  try { plan = JSON.parse(planText.replace(/^\uFEFF/, "")); } catch (e) { return fallback(`Plan file was not valid JSON: ${String(e?.message || e).slice(0, 120)}`); }
  if (plan.persona) push({ type: "finding", section: "persona", label: "Summary", claim: plan.persona, via: "Meetble" });
  const ranked = plan.actions || [];
  if (!ranked.length) return fallback("No actions came back from Step 5");
  // Keep live cards Step 5 didn't cover, so a path found during research never disappears. A card is covered when
  // Step 5 ranked the same route (type + link) and, for routes through a person, names that same person.
  const coveredBy = (l) => ranked.some((a) => a.type === l.type && (a.channel_url || "") === (l.channel_url || "")
    && (!l.contact || `${a.title} ${(a.how || []).join(" ")}`.toLowerCase().includes(l.contact.replace(/^@/, "").toLowerCase())));
  const extra = j.live.filter((l) => !coveredBy(l));
  push({ type: "actions", actions: [...ranked, ...extra].map(toUiAction), p_total: plan.p_total, summary: plan.plan_summary || "" });
}

// ---------- sign-ins: read your Chrome's session cookies over CDP (no agent, no tab opened, answers in under a second) ----------
// One WebSocket to Chrome stays open, so Chrome's "Allow remote debugging?" prompt is clicked once per server run, not per check.
// Same rules as browser_tools.py cookie-check.
const LOGIN_URLS = { luma: "https://luma.com/signin", linkedin: "https://www.linkedin.com/login", x: "https://x.com/login", instagram: "https://www.instagram.com/accounts/login/" };
const SESSION_COOKIES = {
  luma: [["luma.com", "lu.ma"], (n) => /auth/i.test(n)], // luma.auth-session-key
  linkedin: [["linkedin.com"], (n) => n === "li_at"],
  x: [["x.com", "twitter.com"], (n) => n === "auth_token"],
  instagram: [["instagram.com"], (n) => n === "sessionid"],
};
export function sitesFromCookies(cookies, now = Date.now() / 1000) {
  const sites = {};
  for (const [site, [domains, isSession]] of Object.entries(SESSION_COOKIES)) {
    const hit = cookies.some((c) => domains.some((d) => c.domain.replace(/^\./, "") === d || c.domain.endsWith("." + d))
      && isSession(c.name) && c.value && (c.session || !(c.expires > 0) || c.expires > now));
    sites[site] = { logged_in: hit, account: "" };
  }
  return sites;
}
function devToolsUrl() {
  if (process.env.MEETBLE_CDP_URL) return process.env.MEETBLE_CDP_URL;
  const local = process.env.LOCALAPPDATA || "", home = process.env.HOME || process.env.USERPROFILE || "";
  const dirs = [join(local, "Google", "Chrome", "User Data"), join(local, "Google", "Chrome Dev", "User Data"), join(local, "Google", "Chrome SxS", "User Data"),
    join(home, "Library", "Application Support", "Google", "Chrome"), join(home, ".config", "google-chrome")];
  for (const d of dirs) {
    const f = join(d, "DevToolsActivePort");
    if (!existsSync(f)) continue;
    const [port, path] = readFileSync(f, "utf8").split(/\s+/);
    if (port && path) return `ws://127.0.0.1:${port}${path}`;
  }
  return null;
}
const HOW_TO_ON = "Turn on remote debugging: open chrome://inspect/#remote-debugging in Chrome, switch it on, then press Check again.";
let cdp = null; // { ws, open: Promise, calls: Map }
function cdpConnect(url) {
  const ws = new WebSocket(url), calls = new Map(), c = { ws, calls, url };
  c.open = new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(Object.assign(new Error("allow"), { code: "allow" })); try { ws.close(); } catch {} }, 120_000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(Object.assign(new Error("unreachable"), { code: "unreachable" })); };
  });
  ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); const k = calls.get(d.id); if (k) { calls.delete(d.id); d.error ? k.reject(new Error(d.error.message)) : k.resolve(d.result); } };
  ws.onclose = () => { if (cdp === c) cdp = null; for (const k of calls.values()) k.reject(new Error("Chrome closed the connection")); };
  c.send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (c.n = (c.n || 0) + 1);
    calls.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => calls.has(id) && (calls.delete(id), reject(new Error("Chrome did not answer"))), 15_000);
  });
  return c;
}
let logins = null, loginsAt = 0, loginsBusy = null, loginPhase = "idle"; // idle | connecting | reading
async function cookieCheck() {
  if (typeof WebSocket === "undefined") return { error: "This needs Node 22 or newer (node -v).", code: "node" };
  const url = devToolsUrl();
  if (!url) return { error: "Chrome's remote debugging is off. " + HOW_TO_ON, code: "off" };
  if (!cdp || cdp.url !== url) { try { cdp?.ws.close(); } catch {} cdp = cdpConnect(url); }
  const c = cdp;
  try { loginPhase = "connecting"; await c.open; }
  catch (e) {
    if (cdp === c) cdp = null;
    return e.code === "allow"
      ? { error: "Chrome is waiting for you to click Allow on its remote-debugging prompt. Click Allow, then press Check again.", code: "allow" }
      : { error: "Chrome isn't reachable (is it open, with remote debugging on?). " + HOW_TO_ON, code: "unreachable" };
  }
  loginPhase = "reading";
  const { cookies } = await c.send("Storage.getCookies");
  const sites = sitesFromCookies(cookies || []);
  return { sites, signed_out: Object.keys(sites).filter((s) => !sites[s].logged_in), method: "cookies" };
}
async function checkLogins(force) {
  if (!force && logins && !logins.error && Date.now() - loginsAt < 15_000) return logins;
  if (!loginsBusy) loginsBusy = (async () => {
    try { logins = await cookieCheck(); }
    catch (e) { logins = { error: "Couldn't read sign-ins from Chrome: " + String(e?.message || e).slice(0, 160), code: "failed" }; }
    logins = { ...logins, urls: LOGIN_URLS, checked_at: new Date().toISOString() };
    loginsAt = Date.now(); loginsBusy = null; loginPhase = "idle";
    return logins;
  })();
  return loginsBusy;
}

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
const send = (res, code, body, type = "application/json; charset=utf-8") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  // The hosted UI (GitHub Pages) may call this local server. Only that origin, only from this computer (we bind 127.0.0.1).
  const origin = req.headers.origin || "";
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-private-network", "true");
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, readFileSync(join(ROOT, "ui", "index.html")), MIME[".html"]);
    if (TOKEN && p.startsWith("/api/") && p !== "/api/health" && url.searchParams.get("token") !== TOKEN) return send(res, 401, { error: "missing or wrong token" });
    if (p === "/api/logins/phase") return send(res, 200, { phase: loginPhase });
    if (p === "/api/logins") return send(res, 200, await checkLogins(url.searchParams.has("refresh")));
    if (p === "/api/health") return send(res, 200, { ok: true, has_dist: existsSync(join(ROOT, "dist", "cli.js")), has_research: existsSync(RESEARCH), has_profile: existsSync(join(ROOT, "user_profile.json")), has_env: existsSync(join(ROOT, ".env")) });
    if (p === "/api/parse") return send(res, 200, parseAsk(url.searchParams.get("ask")));
    if (req.method === "POST" && p === "/api/run") {
      let raw = ""; for await (const c of req) raw += c;
      const j = startJob(JSON.parse(raw || "{}"));
      return send(res, 200, { id: j.id, ask: j.ask });
    }
    if (req.method === "POST" && p === "/api/stop") { stopJob(); return send(res, 200, { ok: true }); }
    if (p === "/api/stream") {
      if (!job || job.id !== url.searchParams.get("id")) return send(res, 404, { error: "no such run" });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      const j = job;
      for (const ev of j.events) res.write(`data: ${JSON.stringify(ev)}\n\n`); // replay, so a reconnect never restarts the run
      if (j.done) return res.end();
      j.clients.add(res);
      req.on("close", () => j.clients.delete(res));
      return;
    }
    const f = { "/out/plan.md": join(OUT, "plan.md"), "/out/plan.json": PLAN, "/out/research.json": RESEARCH }[p];
    if (f) return existsSync(f) ? send(res, 200, readFileSync(f), MIME[f.slice(f.lastIndexOf("."))]) : send(res, 404, { error: "not yet" });
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e?.message || e) });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, HOST, () => console.log(`Meetble is running on ${HOST}:${PORT}`));
}
export { server, toUiAction, findingEvents, dateOf, nicheOf, checkLogins };
