import type { Confidence, Target, ToolContext } from "../core/types.js";
import { clip, dedupeByUrl, failedNote, haystack, hostOf, mentionsName, searchAll, toIsoDate } from "./resolve_target.js";

// Step 1: bio, interviews, essays and talks about/by the target.

export interface SearchWebInput { target: Target }
export type WebKind = "bio" | "interview" | "essay";
export interface WebItem { kind: WebKind; title: string; url: string; date?: string; snippet?: string; format?: "talk" }
export interface SearchWebResult { items: WebItem[]; failed_queries: number }

const TALK_HOSTS = ["youtube.com", "youtu.be", "vimeo.com"];
const INTERVIEW_RE = /\b(interview|q&a|q & a|conversation with|podcast|fireside|in conversation|talks? (with|to)|episode|ep\.)\b/i;
const TALK_RE = /\b(talk|keynote|panel|lecture|presentation)\b/i;

/** Kind of a result: authored by the target → essay; interview/talk wording or video host → interview; else by the query that found it. */
function classify(title: string, author: string | null | undefined, url: string, q: number, name: string): { kind: WebKind; format?: "talk" } {
  const host = hostOf(url);
  const isVideo = TALK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (author && mentionsName(author, name) && !INTERVIEW_RE.test(title)) return { kind: "essay" };
  if (INTERVIEW_RE.test(title)) return { kind: "interview" };
  if (isVideo || TALK_RE.test(title)) return { kind: "interview", format: "talk" };
  // Essays require an author match (above); an unauthored page about the target counts as bio material.
  return { kind: q === 1 ? "interview" : "bio" };
}

export async function search_web(input: SearchWebInput, ctx: ToolContext): Promise<SearchWebResult> {
  const t = input.target;
  const name = t.name.trim();
  const ctxWords = [t.role, t.company].filter(Boolean).join(" ");
  const highlights = { query: `${name}'s background, views and experience` };
  const { lists, failed } = await searchAll(
    [
      { query: `${name} ${ctxWords} biography background career`.replace(/\s+/g, " ").trim(), numResults: 8, text: { maxCharacters: 1500 }, highlights },
      { query: `interview with ${name}${t.company ? ` (${t.company})` : ""}`, numResults: 8, highlights },
      { query: `essay or blog post written by ${name}`, numResults: 8, highlights },
    ],
    ctx,
  );

  const items: WebItem[] = [];
  for (const { r, q } of dedupeByUrl(lists)) {
    if (!mentionsName(haystack(r), name)) continue; // irrelevant result
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : hostOf(r.url) || r.url;
    const { kind, format } = classify(title, r.author, r.url, q, name);
    const date = toIsoDate(r.publishedDate);
    const hl = Array.isArray(r.highlights) ? r.highlights.find((h) => typeof h === "string" && h.trim()) : undefined;
    const snippet = hl ? clip(hl) : typeof r.text === "string" && r.text.trim() ? clip(r.text) : undefined;
    const inTitle = mentionsName(title, name);
    const confidence: Confidence = inTitle || kind === "essay" ? "high" : "medium";
    const label = kind === "bio" ? "Profile/bio" : kind === "essay" ? "Essay by" : format === "talk" ? "Talk featuring" : "Interview with";
    ctx.findings.save({
      step: "step1",
      tool: "search_web",
      kind,
      claim: `${label} ${name}: ${clip(title, 140)}`,
      source_url: r.url,
      ...(snippet ? { quote: snippet } : {}),
      ...(date ? { date } : {}),
      confidence,
      data: { title, ...(format ? { format } : {}), host: hostOf(r.url), author_match: kind === "essay" },
    });
    items.push({ kind, title, url: r.url, ...(date ? { date } : {}), ...(snippet ? { snippet } : {}), ...(format ? { format } : {}) });
  }
  return { items, failed_queries: failed };
}

export function summarizeSearchWeb(r: SearchWebResult): string {
  if (!r.items.length) return `nothing found${failedNote(r.failed_queries, 3)}`;
  const n = (k: WebKind) => r.items.filter((i) => i.kind === k).length;
  const parts = ([["bio", "bio page", "bio pages"], ["interview", "interview/talk", "interviews/talks"], ["essay", "essay", "essays"]] as const)
    .map(([k, one, many]) => [n(k), one, many] as const)
    .filter(([c]) => c > 0)
    .map(([c, one, many]) => `${c} ${c === 1 ? one : many}`);
  return `found ${parts.join(", ")}${failedNote(r.failed_queries, 3)}`;
}
