// Step 1 (computer use): open the target's LinkedIn profile in the user's own logged-in Chrome and read it.
// Runs browser_tools.py (browser-use + Claude) as a child process, so the Node runner keeps zero npm deps.
// Skipped (not failed) when the Python venv / script / LinkedIn URL is missing.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isHttpUrl } from "../core/findings.js";
import type { Target, ToolContext } from "../core/types.js";

export interface LinkedInData {
  profile_url?: string; name?: string; headline?: string; current_role?: string; location?: string;
  connection_degree?: string; mutual_connections?: string[]; recent_activity?: string[]; accepts_messages?: string; notes?: string;
}
export interface LinkedInProfileResult { skipped?: boolean; reason?: string; data?: LinkedInData }

export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const runProcess: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { p.kill(); stderr += `\ntimed out after ${timeoutMs} ms`; }, timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e) }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });

/** Default python: the project venv (Windows or POSIX layout), overridable with BROWSER_PYTHON. */
export function findPython(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env.BROWSER_PYTHON) return env.BROWSER_PYTHON;
  for (const p of [join(cwd, ".venv", "Scripts", "python.exe"), join(cwd, ".venv", "bin", "python")]) if (existsSync(p)) return p;
  return undefined;
}

/** browser_tools.py prints one JSON object (indented); browser-use may log lines before it. Take the last top-level object. */
export function lastJsonObject(text: string): unknown {
  for (let i = text.lastIndexOf("\n{"); i >= -1; i = text.lastIndexOf("\n{", i - 1)) {
    const start = i === -1 ? text.indexOf("{") : i + 1;
    if (start < 0) return undefined;
    try { return JSON.parse(text.slice(start).trim()); } catch { /* keep looking further up */ }
    if (i <= 0) break;
  }
  try { return JSON.parse(text.trim()); } catch { return undefined; }
}

export async function linkedinProfile(
  input: { target: Target },
  ctx: ToolContext,
  deps: { run?: Runner; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<LinkedInProfileResult> {
  const t = input.target;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  if (env.MEETBLE_BROWSER === "0") return { skipped: true, reason: "browser disabled (MEETBLE_BROWSER=0)" };
  const script = join(cwd, "browser_tools.py");
  if (!existsSync(script)) return { skipped: true, reason: "browser_tools.py not found" };
  const python = findPython(cwd, env);
  if (!python) return { skipped: true, reason: "no .venv with browser-use (see README)" };
  const who = t.linkedin_url ?? t.name;
  const { code, stdout, stderr } = await (deps.run ?? runProcess)(python, [script, "linkedin-profile", who], deps.timeoutMs ?? 300_000);
  const json = lastJsonObject(stdout) as (LinkedInData & { error?: string }) | undefined;
  if (code !== 0 || !json || json.error) {
    const why = json?.error ?? (stderr.trim().split(/\r?\n/).pop() || `exit ${code}`);
    throw new Error(`browser: ${why.slice(0, 160)}`);
  }
  const url = isHttpUrl(json.profile_url) ? json.profile_url : t.linkedin_url;
  if (url) {
    const add = (kind: string, claim: string, data?: Record<string, unknown>) =>
      ctx.findings.save({ step: "step1", tool: "linkedin_profile", kind, claim, source_url: url, confidence: "high", data });
    if (json.headline) add("bio", `LinkedIn headline: ${json.headline}`, { current_role: json.current_role, location: json.location });
    if (json.connection_degree) add("network", `Your connection degree to ${t.name}: ${json.connection_degree}`, { accepts_messages: json.accepts_messages });
    if (json.mutual_connections?.length) add("mutuals", `Mutual connections: ${json.mutual_connections.slice(0, 10).join(", ")}`, { mutual_connections: json.mutual_connections });
    for (const a of (json.recent_activity ?? []).slice(0, 5)) add("post", `Recent LinkedIn activity: ${a}`);
  }
  return { data: json };
}

export function summarizeLinkedInProfile(r: LinkedInProfileResult): string {
  if (r.skipped) return r.reason ?? "skipped";
  const d = r.data ?? {};
  const parts = [d.headline, d.connection_degree && `${d.connection_degree} degree`, d.mutual_connections?.length ? `${d.mutual_connections.length} mutuals` : ""].filter(Boolean);
  return parts.join(", ") || "profile read";
}
