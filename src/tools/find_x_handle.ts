import type { Target, ToolContext } from "../core/types.js";
import { isValidHandle, normalizeHandle, parseStatusUrl, sameHandle, xaiXSearch, ymdDaysAgo } from "./xai.js";
export interface FindXHandleResult { handle?: string; evidence_url?: string; skipped?: boolean; reason?: string }
export function buildHandlePrompt(t: Target): string {
  const who = [t.name, [t.role, t.company].filter(Boolean).join(" at ")].filter(Boolean).join(", ");
  return [`Find the personal X (Twitter) account of ${who}.`, `Search X and cite at least one post written by that account.`, `Reply with STRICT JSON only: {"handle": "<handle without @>"} or {"handle": null} if you are not sure it is this person.`].join(" ");
}
export async function findXHandle(input: { target: Target }, ctx: ToolContext): Promise<FindXHandleResult> {
  const t = input.target;
  if (t.x_handle) return { skipped: true, reason: `already known: @${t.x_handle}` };
  const r = await xaiXSearch({ prompt: buildHandlePrompt(t), fromDate: ymdDaysAgo(ctx.now(), 365) }, ctx);
  const raw = (r.json as { handle?: unknown } | null)?.handle;
  const handle = typeof raw === "string" ? normalizeHandle(raw) : "";
  if (!handle || !isValidHandle(handle)) return { reason: "Grok found no account" };
  let own = r.citations.map(parseStatusUrl).find((s) => s?.user && sameHandle(s.user, handle));
  if (!own) {
    const v = await xaiXSearch({
      prompt: `Read the X account @${handle}. Reply with STRICT JSON only: {"display_name": "...", "bio": "..."} and cite one recent post by this account.`,
      handles: [handle],
      fromDate: ymdDaysAgo(ctx.now(), 365),
    }, ctx);
    const info = (v.json ?? {}) as { display_name?: unknown; bio?: unknown };
    const label = [info.display_name, info.bio].filter((x): x is string => typeof x === "string").join(" ");
    const post = v.citations.map(parseStatusUrl).find((s) => s?.user && sameHandle(s.user, handle));
    if (!post || !namesTarget(label, t.name)) return { reason: `@${handle} suggested but not confirmed as ${t.name}` };
    own = post;
  }
  ctx.findings.save({ step: "step0", tool: "find_x_handle", kind: "profile", claim: `${t.name}'s X account is @${handle}`, source_url: own.url, confidence: "medium", data: { platform: "x", handle } });
  return { handle, evidence_url: own.url };
}
export function namesTarget(label: string, name: string): boolean {
  const fold = (x: string) => x.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hay = fold(label);
  const toks = fold(name).split(/[^a-z0-9]+/).filter((x) => x.length >= 2);
  return toks.length > 0 && toks.every((tk) => hay.includes(tk));
}
export function summarizeFindXHandle(r: FindXHandleResult): string { return r.handle ? `@${r.handle}` : r.reason ?? "not found"; }
