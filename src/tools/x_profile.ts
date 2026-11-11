import type { Target, ToolContext } from "../core/types.js";
import {
  STRICT_JSON,
  isValidHandle,
  normalizeHandle,
  parseStatusUrl,
  sameHandle,
  toYmd,
  xaiXSearch,
  ymdDaysAgo,
} from "./xai.js";

// Step 1: the target's own recent X activity (last 30 days) via Grok X Search, restricted to their handle.

// 30 days and fewer items: the 60-day / 15-post ask timed out at 240 s on every live run.
export const X_PROFILE_DAYS = 30;
const TOOL = "x_profile";

export interface XPost { text: string; date?: string; url: string; cited: boolean }
export interface InnerCircleMember { handle: string; count: number }

export type XProfileResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      handle: string;
      fromDate: string;
      posts: XPost[];
      innerCircle: InnerCircleMember[];
      topics: string[];
      postingHoursUtc: number[];
      citations: string[];
      /** Set when Grok's answer had no parseable JSON: the raw text, for debugging. No items are derived from it. */
      rawText?: string;
    };

export function buildXProfilePrompt(handle: string, fromDate: string, today: string): string {
  return [
    `Today is ${today} (UTC). Use X search to study the X account @${handle} from ${fromDate} until today.`,
    `Return a JSON object with exactly these keys:`,
    `{"posts":[{"text":"verbatim post text","date":"YYYY-MM-DD","url":"https://x.com/${handle}/status/<id>"}],`,
    ` "inner_circle":[{"handle":"other_account_without_at","count":<number of replies from @${handle} to them>}],`,
    ` "topics":["topic they keep returning to"],`,
    ` "posting_hours_utc":[<integer hour 0-23 when they usually post, UTC>]}`,
    `"posts": up to 8 recent ORIGINAL posts written by @${handle} (not reposts, not replies), newest first.`,
    `"inner_circle": up to 5 accounts @${handle} replies to most often, sorted by count descending.`,
    `"topics": up to 5 short topic labels. Use empty arrays when you find nothing.`,
    STRICT_JSON,
  ].join("\n");
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function xProfile(input: { target: Target }, ctx: ToolContext): Promise<XProfileResult> {
  const handle = normalizeHandle(input.target.x_handle);
  if (!handle) return { skipped: true, reason: "no X handle for target" };
  if (!isValidHandle(handle)) return { skipped: true, reason: `invalid X handle ${JSON.stringify(input.target.x_handle)}` };

  const now = ctx.now();
  const today = now.toISOString().slice(0, 10);
  const fromDate = ymdDaysAgo(now, X_PROFILE_DAYS);
  // No to_date: the API treats it as exclusive, so to_date=today would drop today's posts.
  const r = await xaiXSearch({ prompt: buildXProfilePrompt(handle, fromDate, today), handles: [handle], fromDate }, ctx);

  const data = asObj(r.json);
  const parsed = r.json !== null && typeof r.json === "object" && !Array.isArray(r.json);
  const citedIds = new Set(r.citations.map((u) => parseStatusUrl(u)?.id));

  // posts: only well-formed status URLs authored by the target (or /i/status/), inside the window, deduped by id.
  const posts: XPost[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(data.posts)) {
    const p = asObj(raw);
    const s = parseStatusUrl(p.url);
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!s || !text || seen.has(s.id)) continue;
    if (s.user && !sameHandle(s.user, handle)) continue; // someone else's post: not an original post by the target
    const date = toYmd(p.date);
    if (date && (date < fromDate || date > today)) continue;
    seen.add(s.id);
    posts.push({ text, date, url: s.url, cited: citedIds.has(s.id) });
  }

  // inner circle: valid handles, never the target, positive integer counts, merged case-insensitively.
  const counts = new Map<string, InnerCircleMember>();
  for (const raw of asArray(data.inner_circle)) {
    const m = asObj(raw);
    const h = normalizeHandle(typeof m.handle === "string" ? m.handle : undefined);
    const count = typeof m.count === "number" ? m.count : Number(m.count);
    if (!h || !isValidHandle(h) || sameHandle(h, handle)) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    const key = h.toLowerCase();
    const prev = counts.get(key);
    counts.set(key, { handle: prev?.handle ?? h, count: (prev?.count ?? 0) + Math.round(count) });
  }
  const innerCircle = [...counts.values()].sort((a, b) => b.count - a.count);

  const topics = [...new Set(asArray(data.topics).filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))];
  const postingHoursUtc = [...new Set(asArray(data.posting_hours_utc).filter((h): h is number => Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23))];

  for (const p of posts) {
    ctx.findings.save({
      step: "step1",
      tool: TOOL,
      kind: "post",
      claim: `@${handle} posted on X${p.date ? ` on ${p.date}` : ""}: "${truncate(p.text, 200)}"`,
      source_url: p.url,
      quote: p.text,
      date: p.date,
      confidence: p.cited ? "high" : "medium",
      data: { handle, cited: p.cited },
    });
  }
  const profileUrl = `https://x.com/${handle}`;
  for (const m of innerCircle) {
    ctx.findings.save({
      step: "step1",
      tool: TOOL,
      kind: "inner_circle",
      claim: `@${handle} replied to @${m.handle} ${m.count} time${m.count === 1 ? "" : "s"} in the last ${X_PROFILE_DAYS} days`,
      source_url: profileUrl,
      confidence: "medium",
      data: { handle: m.handle, count: m.count, window_days: X_PROFILE_DAYS },
    });
  }

  return {
    skipped: false,
    handle,
    fromDate,
    posts,
    innerCircle,
    topics,
    postingHoursUtc,
    citations: r.citations,
    ...(parsed ? {} : { rawText: r.text }),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function summarizeXProfile(r: XProfileResult): string {
  if (r.skipped) return `skipped: ${r.reason}`;
  if (r.rawText !== undefined) return "Grok answer was not valid JSON; no posts saved";
  const parts = [`${r.posts.length} post${r.posts.length === 1 ? "" : "s"}`];
  const top = r.innerCircle[0];
  if (top) parts.push(`replies most to @${top.handle}`);
  if (r.topics.length) parts.push(`topics: ${r.topics.slice(0, 3).join(", ")}`);
  return parts.join(", ");
}
