import type { Confidence, Target, ToolContext } from "../core/types.js";
import type { ExaResult } from "./exa.js";
import { clip, dedupeByUrl, failedNote, fold, haystack, hostOf, mentionsName, nameTokens, searchAll, toIsoDate } from "./resolve_target.js";

// Step 1: podcast episodes / talks the target appeared on, and quotes in their own words.

export interface PodcastQuotesInput { target: Target }
export type QuoteTheme = "excites" | "frustrates" | "looking_for" | "repeated_story" | "other";
export interface Episode { title: string; url: string; date?: string }
export interface Quote { text: string; url: string; date?: string; theme: QuoteTheme; how: "speaker_label" | "attributed" | "first_person" }
export interface PodcastQuotesResult { episodes: Episode[]; quotes: Quote[]; failed_queries: number }

export const PODCAST_DOMAINS = ["youtube.com", "podcasts.apple.com", "open.spotify.com", "listennotes.com"];
const EPISODE_RE = /\b(podcast|episode|ep\.?\s*\d+|#\d+|interview|talk|keynote|fireside|panel|show|conversation)\b/i;
const MAX_QUOTES = 15;
const MAX_PER_SOURCE = 5;

/**
 * Theme heuristic (first match wins, in this order):
 *  looking_for    – "looking for", "want to see", "I'd love", "wish", "we invest/back/fund", "should build", "hoping", "excited to meet"
 *  frustrates     – "frustrat", "annoy", "hate", "broken", "painful", "waste", "tired of", "worst", "can't stand", "overrated", "mistake"
 *  excites        – "excit", "love", "amazing", "fascinat", "incredible", "favorite", "thrilled", "bullish", "magic", "fun"
 *  repeated_story – storytelling markers: "back when", "years ago", "I remember", "the first time", "early days", "when we started/founded", "story"
 *  other          – anything else
 */
export function classifyQuote(text: string): QuoteTheme {
  const t = fold(text);
  if (/\b(looking for|want to see|i'?d love|we'?d love|i wish|wish (there|someone|more)|we (invest|back|fund)|should build|hoping|excited to meet|searching for)\b/.test(t)) return "looking_for";
  if (/(frustrat|annoy|\bhate|\bbroken\b|painful|\bwaste|tired of|\bworst\b|can'?t stand|overrated|\bmistake)/.test(t)) return "frustrates";
  if (/(excit|\blove\b|\bloved\b|amazing|fascinat|incredible|favou?rite|thrilled|bullish|\bmagic|\bfun\b)/.test(t)) return "excites";
  if (/\b(back when|years ago|i remember|the first time|early days|when (we|i) (started|founded|launched)|story)\b/.test(t)) return "repeated_story";
  return "other";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|we|we're|we've|my|our)\b/i;

function sentences(s: string): string[] {
  return s
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"“])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function okLength(s: string): boolean {
  return s.length >= 30 && s.length <= 400;
}

/**
 * Pulls sentences that are plausibly the target's own words:
 *  1. speaker-labelled transcript lines ("Boris:" / "Boris Jabes:" / "JABES:")         → high
 *  2. quoted text attributed to them ("…," Jabes said / Jabes says: "…")              → high
 *  3. first-person highlight sentences on a page that names them in the title, as long as
 *     the sentence does not refer to them in the third person and is not a question       → low
 */
export function extractQuotes(r: ExaResult, name: string): Array<{ text: string; how: Quote["how"]; confidence: Confidence }> {
  // Regexes run on the original text, so build them from the original spelling of the name.
  const words = name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")).filter((w) => w.length >= 2).map(escapeRe);
  const first = words[0];
  const last = words[words.length - 1];
  const foldedLast = nameTokens(name).at(-1);
  if (!first || !last || !foldedLast) return [];
  const out: Array<{ text: string; how: Quote["how"]; confidence: Confidence }> = [];
  const push = (text: string, how: Quote["how"], confidence: Confidence) => {
    const t = text.replace(/\s+/g, " ").replace(/^["“'‘]+|["”'’]+$/g, "").replace(/[,;:]+$/, "").trim();
    if (!okLength(t) || t.endsWith("?")) return;
    if (out.some((o) => fold(o.text) === fold(t))) return;
    out.push({ text: t, how, confidence });
  };
  const raw = [typeof r.text === "string" ? r.text : "", ...(Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string") : [])].join("\n");
  if (!raw.trim()) return out;
  const nameAlt = words.length > 1 ? `${first}(?:\\s+${last})?|${last}` : first;
  const nb = "(?<![\\p{L}\\p{N}])"; // left word boundary that also works for non-ASCII letters

  // 1. Speaker labels at line start.
  const label = new RegExp(`(?:^|\\n)[ \\t]*(?:${nameAlt})[ \\t]*(?:\\([^)\\n]*\\))?[ \\t]*:[ \\t]*([^\\n]+)`, "giu");
  for (const m of raw.matchAll(label)) for (const sen of sentences(m[1] ?? "")) push(sen, "speaker_label", "high");

  // 2. Attributed quotations.
  const said = "(?:said|says|explains|explained|notes|noted|told|tells|added|recalls|recalled|argues|argued)";
  const after = new RegExp(`["“]([^"”]{30,400})["”],?\\s+(?:${said}\\s+(?:${first}\\s+)?${last}|${nb}(?:${first}\\s+)?${last}\\s+${said})`, "giu");
  const before = new RegExp(`${nb}(?:${first}\\s+)?${last}\\s+${said}[:,]?\\s+["“]([^"”]{30,400})["”]`, "giu");
  for (const re of [after, before]) {
    for (const m of raw.matchAll(re)) if (m[1]) push(m[1], "attributed", "high");
  }

  // 3. First-person sentences from highlights, only when the page is about this person.
  if (mentionsName(r.title, name) && Array.isArray(r.highlights)) {
    const third = new RegExp(`\\b(${escapeRe(foldedLast)}|he|she|his|her|him)\\b`, "i");
    for (const h of r.highlights) {
      if (typeof h !== "string") continue;
      for (const s of sentences(h)) if (FIRST_PERSON.test(s) && !third.test(fold(s))) push(s, "first_person", "low");
    }
  }
  return out;
}

export async function podcast_quotes(input: PodcastQuotesInput, ctx: ToolContext): Promise<PodcastQuotesResult> {
  const name = input.target.name.trim();
  const highlights = { query: `${name} in their own words: opinions, advice, what excites or frustrates them, stories` };
  const { lists, failed } = await searchAll(
    [
      { query: `"${name}" podcast interview`, includeDomains: PODCAST_DOMAINS, numResults: 10, text: { maxCharacters: 6000 }, highlights },
      { query: `${name}${input.target.company ? ` ${input.target.company}` : ""} podcast episode guest`, numResults: 8, text: { maxCharacters: 6000 }, highlights },
    ],
    ctx,
  );

  const episodes: Episode[] = [];
  const quotes: Quote[] = [];
  for (const { r } of dedupeByUrl(lists)) {
    if (!mentionsName(haystack(r), name)) continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : hostOf(r.url) || r.url;
    const onPodcastHost = PODCAST_DOMAINS.some((d) => hostOf(r.url) === d || hostOf(r.url).endsWith(`.${d}`));
    if (!onPodcastHost && !EPISODE_RE.test(title)) continue; // not an episode/talk page
    const date = toIsoDate(r.publishedDate);
    episodes.push({ title, url: r.url, ...(date ? { date } : {}) });
    ctx.findings.save({
      step: "step1",
      tool: "podcast_quotes",
      kind: "podcast",
      claim: `${name} appeared on: ${clip(title, 140)}`,
      source_url: r.url,
      ...(date ? { date } : {}),
      confidence: mentionsName(title, name) ? "high" : "medium",
      data: { title, host: hostOf(r.url) },
    });
    for (const q of extractQuotes(r, name).slice(0, MAX_PER_SOURCE)) {
      if (quotes.length >= MAX_QUOTES) break;
      if (quotes.some((x) => fold(x.text) === fold(q.text))) continue;
      const theme = classifyQuote(q.text);
      quotes.push({ text: q.text, url: r.url, ...(date ? { date } : {}), theme, how: q.how });
      ctx.findings.save({
        step: "step1",
        tool: "podcast_quotes",
        kind: "quote",
        claim: `${name} on "${clip(title, 80)}": ${clip(q.text, 120)}`,
        source_url: r.url,
        quote: q.text,
        ...(date ? { date } : {}),
        confidence: q.confidence,
        data: { theme, how: q.how, episode: title },
      });
    }
  }
  return { episodes, quotes, failed_queries: failed };
}

export function summarizePodcastQuotes(r: PodcastQuotesResult): string {
  if (!r.episodes.length) return `nothing found${failedNote(r.failed_queries, 2)}`;
  const ep = `${r.episodes.length} podcast${r.episodes.length === 1 ? "" : "s"}/talk${r.episodes.length === 1 ? "" : "s"}`;
  return `found ${ep}, ${r.quotes.length} quote${r.quotes.length === 1 ? "" : "s"}${failedNote(r.failed_queries, 2)}`;
}
