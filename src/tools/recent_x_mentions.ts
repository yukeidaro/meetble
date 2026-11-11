import type { Target, ToolContext } from "../core/types.js";
import { STRICT_JSON, isValidHandle, normalizeHandle, parseStatusUrl, sameHandle, toYmd, xaiXSearch, ymdDaysAgo } from "./xai.js";

// Step 2: what is being said BY or ABOUT the target on X right now (7 days, widened to 30 if empty).

export const MENTION_WINDOW_DAYS = 7;
export const MENTION_WIDE_DAYS = 30;
const TOOL = "recent_x_mentions";

export interface XMention { text: string; date?: string; url: string; author?: string; byTarget: boolean; cited: boolean }

export interface RecentXMentionsResult {
  windowDays: number;
  fromDate: string;
  widened: boolean;
  mentions: XMention[];
  citations: string[];
  /** Raw Grok text of the last call when it had no parseable JSON. */
  rawText?: string;
}

export function buildMentionsPrompt(target: Target, handle: string, fromDate: string, today: string): string {
  const who = handle ? `${target.name} (X handle @${handle})` : target.name;
  const ctxBits = [target.role, target.company].filter(Boolean).join(" at ");
  const queries = [`"${target.name}"`, ...(handle ? [`@${handle}`, `from:${handle}`] : [])].join(", ");
  return [
    `Today is ${today} (UTC). Use X search to find posts from ${fromDate} until today that were written BY or are ABOUT ${who}${ctxBits ? `, ${ctxBits}` : ""}.`,
    `Search for: ${queries}. Ignore posts about other people with the same name.`,
    `Return a JSON object: {"posts":[{"text":"verbatim post text","date":"YYYY-MM-DD","url":"https://x.com/<author>/status/<id>","author":"handle_without_at"}]}`,
    `Up to 15 posts, newest first. Use {"posts":[]} when there are none.`,
    STRICT_JSON,
  ].join("\n");
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function searchWindow(target: Target, handle: string, days: number, ctx: ToolContext) {
  const now = ctx.now();
  const today = now.toISOString().slice(0, 10);
  const fromDate = ymdDaysAgo(now, days);
  // No handle restriction (mentions come from anyone) and no to_date (it is exclusive; today would be dropped).
  const r = await xaiXSearch({ prompt: buildMentionsPrompt(target, handle, fromDate, today), fromDate }, ctx);
  const data = Array.isArray(r.json) ? { posts: r.json } : asObj(r.json);
  const parsed = r.json !== null && typeof r.json === "object";
  const citedIds = new Set(r.citations.map((u) => parseStatusUrl(u)?.id));
  const mentions: XMention[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(data.posts)) {
    const p = asObj(raw);
    const s = parseStatusUrl(p.url);
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!s || !text || seen.has(s.id)) continue;
    const date = toYmd(p.date);
    if (date && (date < fromDate || date > today)) continue; // outside the window we asked for
    const authorRaw = s.user ?? normalizeHandle(typeof p.author === "string" ? p.author : undefined);
    const author = authorRaw && isValidHandle(authorRaw) ? authorRaw : undefined;
    seen.add(s.id);
    mentions.push({ text, date, url: s.url, author, byTarget: !!handle && sameHandle(author, handle), cited: citedIds.has(s.id) });
  }
  return { fromDate, mentions, citations: r.citations, rawText: parsed ? undefined : r.text };
}

export async function recentXMentions(input: { target: Target }, ctx: ToolContext): Promise<RecentXMentionsResult> {
  const { target } = input;
  if (!target?.name?.trim()) throw new Error("recent_x_mentions: target.name is required");
  const h = normalizeHandle(target.x_handle);
  const handle = h && isValidHandle(h) ? h : "";

  let windowDays = MENTION_WINDOW_DAYS;
  let res = await searchWindow(target, handle, windowDays, ctx);
  let widened = false;
  if (res.mentions.length === 0) {
    widened = true;
    windowDays = MENTION_WIDE_DAYS;
    res = await searchWindow(target, handle, windowDays, ctx);
  }

  for (const m of res.mentions) {
    const who = m.author ? `@${m.author}` : "Someone";
    ctx.findings.save({
      step: "step2",
      tool: TOOL,
      kind: "mention",
      claim: m.byTarget
        ? `${target.name} posted on X${m.date ? ` on ${m.date}` : ""}: "${truncate(m.text, 200)}"`
        : `${who} posted about ${target.name} on X${m.date ? ` on ${m.date}` : ""}: "${truncate(m.text, 200)}"`,
      source_url: m.url,
      quote: m.text,
      date: m.date,
      confidence: m.cited ? "high" : "medium",
      data: { author: m.author, by_target: m.byTarget, window_days: windowDays, widened },
    });
  }

  return {
    windowDays,
    fromDate: res.fromDate,
    widened,
    mentions: res.mentions,
    citations: res.citations,
    ...(res.rawText !== undefined ? { rawText: res.rawText } : {}),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function summarizeRecentXMentions(r: RecentXMentionsResult): string {
  const n = r.mentions.length;
  const posts = `${n} post${n === 1 ? "" : "s"}`;
  if (!r.widened) return `${posts} in ${r.windowDays} days`;
  if (n === 0) return `nothing in ${MENTION_WINDOW_DAYS} or ${MENTION_WIDE_DAYS} days`;
  return `nothing in ${MENTION_WINDOW_DAYS} days, widened to ${MENTION_WIDE_DAYS}: ${posts}`;
}
