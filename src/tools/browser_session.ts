// Step 0 (computer use): pre-flight login check + the user's own upcoming Luma events, read in the user's Chrome.
// Yu's rule: do as much research as possible signed in, and ask the human to log in themselves (never type passwords).
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ToolContext } from "../core/types.js";
import { findPython, lastJsonObject, runProcess, type Runner } from "./linkedin_profile.js";

export const LOGIN_SITES = ["luma", "linkedin", "x", "instagram"] as const;
export type LoginSite = (typeof LOGIN_SITES)[number];
export const LOGIN_URLS: Record<LoginSite, string> = {
  luma: "https://luma.com/signin", linkedin: "https://www.linkedin.com/login", x: "https://x.com/login", instagram: "https://www.instagram.com/accounts/login/",
};
export interface SiteLogin { logged_in: boolean; account: string }
export interface LoginCheckResult { skipped?: boolean; reason?: string; sites?: Partial<Record<LoginSite, SiteLogin>>; signed_out?: LoginSite[]; account_mismatch?: string }
export interface MyLumaEvent { title: string; url: string; date_time?: string; status?: string }
export interface MyEventsResult { skipped?: boolean; reason?: string; events: MyLumaEvent[] }

type Deps = { run?: Runner; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };

async function callBrowser(cmd: string, deps: Deps): Promise<{ skipped: string } | { json: Record<string, unknown> }> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  if (env.MEETBLE_BROWSER === "0") return { skipped: "browser disabled (MEETBLE_BROWSER=0)" };
  const script = join(cwd, "browser_tools.py");
  if (!existsSync(script)) return { skipped: "browser_tools.py not found" };
  const python = findPython(cwd, env);
  if (!python) return { skipped: "no .venv with browser-use (see README)" };
  const { code, stdout, stderr } = await (deps.run ?? runProcess)(python, [script, cmd], deps.timeoutMs ?? 300_000);
  const json = lastJsonObject(stdout) as Record<string, unknown> | undefined;
  if (code !== 0 || !json || typeof json !== "object" || json.error) {
    const why = (typeof json?.error === "string" && json.error) || stderr.trim().split(/\r?\n/).pop() || `exit ${code}`;
    throw new Error(`browser: ${why.slice(0, 160)}`);
  }
  return { json };
}

/** Which sites are signed in. LUMA_ACCOUNT (optional, in .env) is the account Luma should be signed in as. */
export async function loginCheck(_input: object, _ctx: ToolContext, deps: Deps = {}): Promise<LoginCheckResult> {
  const r = await callBrowser("login-check", deps);
  if ("skipped" in r) return { skipped: true, reason: r.skipped };
  const sites: Partial<Record<LoginSite, SiteLogin>> = {};
  for (const s of LOGIN_SITES) {
    const v = r.json[s] as Partial<SiteLogin> | undefined;
    if (v && typeof v === "object") sites[s] = { logged_in: v.logged_in === true, account: typeof v.account === "string" ? v.account : "" };
  }
  const signed_out = LOGIN_SITES.filter((s) => !sites[s]?.logged_in);
  const want = (deps.env ?? process.env).LUMA_ACCOUNT?.trim().toLowerCase();
  const got = sites.luma?.account.trim().toLowerCase();
  const account_mismatch = want && sites.luma?.logged_in && got && !got.includes(want) && !want.includes(got) ? `Luma is signed in as ${sites.luma.account}, expected ${want}` : undefined;
  return { sites, signed_out, ...(account_mismatch ? { account_mismatch } : {}) };
}

export function summarizeLoginCheck(r: LoginCheckResult): string {
  if (r.skipped) return r.reason ?? "skipped";
  const on = LOGIN_SITES.filter((s) => r.sites?.[s]?.logged_in);
  const parts = [on.length ? `signed in: ${on.join(", ")}` : "", r.signed_out?.length ? `not signed in: ${r.signed_out.join(", ")}` : "", r.account_mismatch ?? ""];
  return parts.filter(Boolean).join("; ");
}

/** The user's upcoming Luma events (registered or hosting). Their URLs go to find_events, which checks each for the target. */
export async function lumaMyEvents(_input: object, _ctx: ToolContext, deps: Deps = {}): Promise<MyEventsResult> {
  const r = await callBrowser("luma-my-events", deps);
  if ("skipped" in r) return { skipped: true, reason: r.skipped, events: [] };
  const raw = Array.isArray(r.json.events) ? r.json.events : [];
  const events: MyLumaEvent[] = [];
  const seen = new Set<string>();
  for (const e of raw as Array<Record<string, unknown>>) {
    const url = typeof e?.url === "string" ? e.url.trim() : "";
    // Only real Luma event pages: the agent sometimes returns "luma.com/home" or a relative link.
    if (!/^https:\/\/(www\.)?(lu\.ma|luma\.com)\/[^/?#]+/i.test(url) || /\/(home|calendar|discover|settings|user)\b/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    events.push({ title: typeof e.title === "string" ? e.title : url, url, date_time: typeof e.date_time === "string" ? e.date_time : undefined, status: typeof e.status === "string" ? e.status : undefined });
  }
  return { events };
}

export function summarizeLumaMyEvents(r: MyEventsResult): string {
  if (r.skipped) return r.reason ?? "skipped";
  return r.events.length ? `${r.events.length} upcoming events you're going to` : "no upcoming events on your Luma";
}
