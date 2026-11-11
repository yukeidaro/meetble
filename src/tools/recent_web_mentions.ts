import type { Target, ToolContext } from "../core/types.js";
import type { ExaResult } from "./exa.js";
import { exaSearch } from "./exa.js";
import { clip, dedupeByUrl, haystack, hostOf, mentionsName, toIsoDate } from "./resolve_target.js";

// Step 2: web/news mentions in the last 7 days; widens to 30 days (one more call) only if 7 days gives nothing.

export interface RecentWebMentionsInput { target: Target }
export interface Mention { title: string; url: string; date: string; snippet?: string }
export interface RecentWebMentionsResult { mentions: Mention[]; days: 7 | 30; widened: boolean }

const DAY = 86_400_000;

async function searchWindow(target: Target, days: 7 | 30, ctx: ToolContext): Promise<Mention[]> {
  const name = target.name.trim();
  const now = ctx.now();
  // Whole-day window: publishedDate is often day-only (YYYY-MM-DD), so compare by calendar day (UTC).
  const startDay = new Date(now.getTime() - days * DAY).toISOString().slice(0, 10);
  const maxDay = new Date(now.getTime() + DAY).toISOString().slice(0, 10); // tolerate timezone skew
  const raw: ExaResult[] = await exaSearch(
    {
      query: `"${name}"${target.company ? ` ${target.company}` : ""} news`,
      numResults: 10,
      startPublishedDate: `${startDay}T00:00:00.000Z`,
      highlights: { query: `what is said about ${name}` },
    },
    ctx,
  );
  const out: Mention[] = [];
  for (const { r } of dedupeByUrl([raw])) {
    // Re-check the date locally: the API filter is not trusted blindly, and undated results cannot prove recency.
    const date = toIsoDate(r.publishedDate);
    if (!date) continue;
    if (date < startDay || date > maxDay) continue;
    if (!mentionsName(haystack(r), name)) continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : hostOf(r.url) || r.url;
    const hl = Array.isArray(r.highlights) ? r.highlights.find((h) => typeof h === "string" && h.trim()) : undefined;
    const snippet = hl ? clip(hl) : typeof r.text === "string" && r.text.trim() ? clip(r.text) : undefined;
    out.push({ title, url: r.url, date, ...(snippet ? { snippet } : {}) });
  }
  return out;
}

export async function recent_web_mentions(input: RecentWebMentionsInput, ctx: ToolContext): Promise<RecentWebMentionsResult> {
  const name = input.target.name.trim();
  let days: 7 | 30 = 7;
  let mentions = await searchWindow(input.target, 7, ctx);
  if (!mentions.length) {
    days = 30;
    mentions = await searchWindow(input.target, 30, ctx);
  }
  mentions.sort((a, b) => b.date.localeCompare(a.date));
  for (const m of mentions) {
    ctx.findings.save({
      step: "step2",
      tool: "recent_web_mentions",
      kind: "mention",
      claim: `${name} mentioned on ${hostOf(m.url)} (${m.date}): ${clip(m.title, 120)}`,
      source_url: m.url,
      ...(m.snippet ? { quote: m.snippet } : {}),
      date: m.date,
      confidence: mentionsName(m.title, name) ? "high" : "medium",
      data: { window_days: days },
    });
  }
  return { mentions, days, widened: days === 30 };
}

export function summarizeRecentWebMentions(r: RecentWebMentionsResult): string {
  if (!r.mentions.length) return "no mentions in the last 30 days";
  const n = `${r.mentions.length} mention${r.mentions.length === 1 ? "" : "s"}`;
  return r.widened ? `none in 7 days; ${n} in the last 30 days` : `${n} in the last 7 days`;
}
