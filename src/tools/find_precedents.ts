import type { Confidence, Target, ToolContext } from "../core/types.js";
import type { ExaResult } from "./exa.js";
import { clip, dedupeByUrl, failedNote, fold, hostOf, mentionsName, searchAll, toIsoDate } from "./resolve_target.js";

// Step 1: stories of people who got a meeting / intro / reply / investment from the target, and how.

export interface FindPrecedentsInput { target: Target }
export type Channel = "cold_email" | "cold_dm" | "warm_intro" | "event" | "yc_application" | "other";
export type Outcome = "meeting" | "intro" | "reply" | "investment" | "unknown";
export interface Precedent { url: string; title: string; channel: Channel; outcome: Outcome; excerpt: string; date?: string }
export interface FindPrecedentsResult { precedents: Precedent[]; failed_queries: number }

/** Channel keywords, checked in this order within the passage that mentions the target. */
const CHANNELS: Array<[Channel, RegExp]> = [
  ["warm_intro", /\b(introduced (me |us )?(by|to)|intro(duction)? (from|via|through)|warm intro|mutual (friend|connection)|connected (me|us) (with|to))\b/],
  ["cold_email", /\b(cold[- ]?email(ed)?|emailed (him|her|them)|sent (him|her|them) an email|(an |a cold )?email to|wrote to (him|her))\b/],
  ["cold_dm", /\b(dm'?d|dm'?ed|direct message|messaged (him|her) on|twitter dm|linkedin message|reached out on (twitter|x|linkedin))\b/],
  ["event", /\b(met (him|her|them)? ?at|ran into|demo day|office hours|meetup|conference|after (his|her) talk|at an event|hackathon)\b/],
  ["yc_application", /\b(yc interview|applied to (yc|y combinator)|our yc application|interviewed (us|me) at yc)\b/],
];
const OUTCOMES: Array<[Outcome, RegExp]> = [
  ["investment", /\b(invested|angel (check|investment|investor)|backed (us|me)|led our|wrote (us |me )?a check|participated in our)\b/],
  ["meeting", /\b(meeting|met with|call with|coffee|hopped on a call|got (a|on a) call)\b/],
  ["intro", /\b(intro(duced|duction)?)\b/],
  ["reply", /\b(replied|wrote back|responded|got a (reply|response))\b/],
];

/**
 * Passage around a mention at index i: the previous sentence, the sentence with the mention and the next two,
 * capped at 400 chars on each side, so excerpts start and end on sentence boundaries.
 */
function sentenceWindow(s: string, i: number, len: number): string {
  const ends: number[] = [];
  for (const m of s.matchAll(/[.!?]["”')]?(?=\s|$)/g)) ends.push((m.index ?? 0) + m[0].length);
  const before = ends.filter((e) => e <= i);
  let start = before.length >= 2 ? before[before.length - 2]! : 0;
  if (i - start > 400) start = before.at(-1) ?? 0; // previous sentence too long: start at the mention's sentence
  if (i - start > 400) start = i - 400;
  const after = ends.filter((e) => e > i + len);
  let end = after[2] ?? after.at(-1) ?? s.length;
  if (end - (i + len) > 400) end = after[0] !== undefined && after[0] - (i + len) <= 400 ? after[0] : i + len + 400;
  return s.slice(start, end).trim();
}

/** Passages around each mention of the target's last name (matched on the original text, case-insensitive). */
function passages(r: ExaResult, name: string): string[] {
  const words = name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")).filter((w) => w.length >= 2);
  const last = words.at(-1);
  if (!last) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
  const srcs = [typeof r.text === "string" ? r.text : "", ...(Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string") : [])];
  const out: string[] = [];
  for (const s of srcs) {
    for (const m of s.matchAll(re)) {
      const p = sentenceWindow(s, m.index ?? 0, last.length);
      if (!out.includes(p)) out.push(p); // nearby mentions share a passage
      if (out.length >= 12) return out;
    }
  }
  return out;
}

export function detectChannel(text: string): Channel | undefined {
  const t = fold(text);
  return CHANNELS.find(([, re]) => re.test(t))?.[0];
}

export function detectOutcome(text: string): Outcome {
  const t = fold(text);
  return OUTCOMES.find(([, re]) => re.test(t))?.[0] ?? "unknown";
}

export async function find_precedents(input: FindPrecedentsInput, ctx: ToolContext): Promise<FindPrecedentsResult> {
  const name = input.target.name.trim();
  const highlights = { query: `how someone got a meeting, intro, reply or investment from ${name}` };
  const { lists, failed } = await searchAll(
    [
      { query: `how I got a meeting with ${name}: cold email, intro or event`, numResults: 10, text: { maxCharacters: 5000 }, highlights },
      { query: `${name} invested in our startup after we were introduced`, numResults: 10, text: { maxCharacters: 5000 }, highlights },
    ],
    ctx,
  );

  const precedents: Precedent[] = [];
  for (const { r } of dedupeByUrl(lists)) {
    let hit: { channel: Channel; text: string } | undefined;
    for (const p of passages(r, name)) {
      const channel = detectChannel(p);
      if (channel && mentionsName(p, name)) { hit = { channel, text: p }; break; }
    }
    if (!hit) {
      // Fall back to a looser match: the last name in the passage and the full name somewhere in the page.
      const pageMentions = mentionsName([typeof r.title === "string" ? r.title : "", typeof r.text === "string" ? r.text : ""].join("\n"), name);
      for (const p of pageMentions ? passages(r, name) : []) {
        const channel = detectChannel(p);
        if (channel) { hit = { channel, text: p }; break; }
      }
    }
    if (!hit) continue;
    const outcome = detectOutcome(hit.text);
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : hostOf(r.url) || r.url;
    const date = toIsoDate(r.publishedDate);
    const excerpt = clip(hit.text, 400);
    const confidence: Confidence = outcome !== "unknown" && mentionsName(hit.text, name) ? "medium" : "low";
    precedents.push({ url: r.url, title, channel: hit.channel, outcome, excerpt, ...(date ? { date } : {}) });
    ctx.findings.save({
      step: "step1",
      tool: "find_precedents",
      kind: "precedent",
      claim: `Someone reached ${name} via ${hit.channel.replace("_", " ")}${outcome !== "unknown" ? ` (got ${outcome === "investment" ? "an investment" : `a ${outcome}`})` : ""}: ${clip(title, 120)}`,
      source_url: r.url,
      quote: excerpt,
      ...(date ? { date } : {}),
      confidence,
      data: { channel: hit.channel, outcome },
    });
  }
  return { precedents, failed_queries: failed };
}

export function summarizeFindPrecedents(r: FindPrecedentsResult): string {
  if (!r.precedents.length) return `nothing found${failedNote(r.failed_queries, 2)}`;
  const counts = new Map<string, number>();
  for (const p of r.precedents) counts.set(p.channel, (counts.get(p.channel) ?? 0) + 1);
  const by = [...counts].map(([c, n]) => `${n} ${c.replace("_", " ")}`).join(", ");
  return `found ${r.precedents.length} precedent${r.precedents.length === 1 ? "" : "s"} (${by})${failedNote(r.failed_queries, 2)}`;
}
