import type { Target, ToolContext } from "../core/types.js";
import type { ExaResult } from "./exa.js";
import { clip, dedupeByUrl, failedNote, fold, haystack, hostOf, mentionsName, nameTokens, searchAll, toIsoDate } from "./resolve_target.js";

// Step 2: upcoming events the target hosts / speaks at, between now and deadline + GRACE_DAYS.

export interface FindEventsInput { target: Target; deadline: string }
export type EventRole = "host" | "speaker" | "attendee" | "unknown";
export interface FoundEvent { title: string; event_url: string; event_date?: string; role: EventRole }
export interface FindEventsResult { events: FoundEvent[]; window: { from: string; to: string }; failed_queries: number }

export const EVENT_DOMAINS = ["lu.ma", "luma.com", "eventbrite.com"];
export const GRACE_DAYS = 3;
const DAY = 86_400_000;
const UNDATED_MAX_AGE_DAYS = 45; // an event-platform page with no readable date is kept only if published this recently
const EVENT_WORDS = /\b(event|meetup|summit|conference|fireside|panel|keynote|demo day|hackathon|workshop|dinner|happy hour|talk|rsvp|register|tickets?)\b/i;

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function utcDay(y: number, m: number, d: number): Date | undefined {
  const dt = new Date(Date.UTC(y, m, d));
  // Reject overflow like Feb 31 → Mar 3.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : undefined;
}

/**
 * Every calendar date written in the text (UTC midnight). Year-less dates ("Thu, Nov 14") get the year that
 * puts them nearest to `now` (this year, or next year if that would be more than 6 months in the past).
 * Formats: 2026-11-14, November 14(th)(, 2026), Nov 14, 14 November 2026, 11/14/2026.
 */
export function datesInText(text: string, now: Date): Date[] {
  const out: Date[] = [];
  const t = text.replace(/\s+/g, " ");
  const infer = (m: number, d: number) => {
    const y = now.getUTCFullYear();
    const a = utcDay(y, m, d);
    if (!a) return undefined;
    return a.getTime() < now.getTime() - 183 * DAY ? utcDay(y + 1, m, d) : a;
  };
  // (?!\d) rather than \b: ISO date-times continue with "T18:00", where \b never matches.
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
    const d = utcDay(+m[1]!, +m[2]! - 1, +m[3]!);
    if (d) out.push(d);
  }
  const mon = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
  for (const m of t.matchAll(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "gi"))) {
    const mi = MONTHS[m[1]!.toLowerCase()];
    if (mi === undefined) continue;
    const d = m[3] ? utcDay(+m[3], mi, +m[2]!) : infer(mi, +m[2]!);
    if (d) out.push(d);
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}(?:,?\\s+(\\d{4}))?\\b`, "gi"))) {
    const mi = MONTHS[m[2]!.toLowerCase()];
    if (mi === undefined) continue;
    const d = m[3] ? utcDay(+m[3], mi, +m[1]!) : infer(mi, +m[1]!);
    if (d) out.push(d);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const d = utcDay(+m[3]!, +m[1]! - 1, +m[2]!); // US order (event sites in scope are US-centric)
    if (d) out.push(d);
  }
  return out;
}

const ROLE_BEFORE: Array<[EventRole, RegExp]> = [
  ["host", /hosted by|organi[sz]ed by|presented by|\bhosts?\b:?/g],
  ["speaker", /speakers?|featuring|fireside( chat)? with|in conversation with|talk by|panel(ists)?|keynote( by)?|moderated by|lineup/g],
  ["attendee", /attendees?|guests?|joining us/g],
];
const ROLE_AFTER: Array<[EventRole, RegExp]> = [
  ["host", /\(host\)|will host|is hosting|\bhosts\b/],
  ["speaker", /will speak|speaking|keynote|\(speaker\)/],
  ["attendee", /will attend|is attending/],
];
const RANK: Record<EventRole, number> = { host: 3, speaker: 2, attendee: 1, unknown: 0 };

/**
 * Role of the target. For each mention of their last name, the nearest role keyword before it
 * (within 120 chars, same sentence) decides; e.g. "Hosted by Alice. Speakers: Boris Jabes" → speaker,
 * and Luma's "Hosted By\nAlice\nSpeakers\nBoris Jabes" → speaker. Falls back to wording right after the name.
 * Across mentions the strongest role wins (host > speaker > attendee).
 */
export function detectRole(text: string, name: string): EventRole {
  const last = nameTokens(name).at(-1);
  if (!last) return "unknown";
  const f = fold(text);
  const re = new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  let best: EventRole = "unknown";
  for (const m of f.matchAll(re)) {
    const i = m.index ?? 0;
    let pre = f.slice(Math.max(0, i - 120), i);
    const stop = pre.lastIndexOf(". ");
    if (stop !== -1) pre = pre.slice(stop + 2);
    let role: EventRole = "unknown";
    let at = -1;
    for (const [r, kw] of ROLE_BEFORE) {
      for (const k of pre.matchAll(kw)) if ((k.index ?? 0) > at) { at = k.index ?? 0; role = r; }
    }
    if (role === "unknown") {
      const post = f.slice(i + last.length, i + last.length + 80).split(". ")[0] ?? "";
      role = ROLE_AFTER.find(([, kw]) => kw.test(post))?.[0] ?? "unknown";
    }
    if (RANK[role] > RANK[best]) best = role;
  }
  return best;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function find_events(input: FindEventsInput, ctx: ToolContext): Promise<FindEventsResult> {
  const name = input.target.name.trim();
  const dl = toIsoDate(input.deadline);
  if (!dl) throw new Error(`find_events: invalid deadline "${input.deadline}"`);
  const now = ctx.now();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // today 00:00 UTC
  const to = new Date(Date.parse(`${dl}T00:00:00Z`) + GRACE_DAYS * DAY); // inclusive, by day
  const window = { from: ymd(from), to: ymd(to) };
  if (to.getTime() < from.getTime()) throw new Error(`find_events: deadline ${dl} is in the past`);

  const { lists, failed } = await searchAll(
    [
      { query: `${name} event`, includeDomains: EVENT_DOMAINS, numResults: 10, text: { maxCharacters: 3000 } },
      { query: `upcoming event featuring ${name}${input.target.company ? ` (${input.target.company})` : ""}: talk, fireside chat or panel`, numResults: 10, text: { maxCharacters: 3000 } },
    ],
    ctx,
  );

  const events: FoundEvent[] = [];
  for (const { r } of dedupeByUrl(lists)) {
    const hay = haystack(r);
    if (!mentionsName(hay, name)) continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : hostOf(r.url) || r.url;
    const onEventSite = EVENT_DOMAINS.some((d) => hostOf(r.url) === d || hostOf(r.url).endsWith(`.${d}`));
    if (!onEventSite && !EVENT_WORDS.test(`${title}\n${hay.slice(0, 500)}`)) continue;

    // Event date: written dates (title first, then body). The page's publishedDate is when it was posted, not the event.
    const dates = [...datesInText(title, now), ...datesInText(hay, now)];
    const inWindow = dates.find((d) => d.getTime() >= from.getTime() && d.getTime() <= to.getTime());
    let event_date: string | undefined;
    if (inWindow) event_date = ymd(inWindow);
    else if (dates.length) continue; // dated, but in the past or after the window
    else {
      // No readable date: only keep event-platform pages published recently (and never general web pages).
      const pub = toIsoDate(r.publishedDate);
      if (!onEventSite) continue;
      if (!pub || Date.parse(`${pub}T00:00:00Z`) < from.getTime() - UNDATED_MAX_AGE_DAYS * DAY) continue;
    }
    const role = detectRole(hay, name);
    events.push({ title, event_url: r.url, ...(event_date ? { event_date } : {}), role });
    ctx.findings.save({
      step: "step2",
      tool: "find_events",
      kind: "event",
      claim: `${name}${role === "unknown" ? " is mentioned at" : role === "host" ? " hosts" : role === "speaker" ? " speaks at" : " attends"} "${clip(title, 120)}"${event_date ? ` on ${event_date}` : " (date not confirmed)"}`,
      source_url: r.url,
      ...(event_date ? { date: event_date } : {}),
      confidence: event_date && role !== "unknown" ? "high" : event_date ? "medium" : "low",
      data: { event_url: r.url, ...(event_date ? { event_date } : {}), role },
    });
  }
  events.sort((a, b) => (a.event_date ?? "9999").localeCompare(b.event_date ?? "9999"));
  return { events, window, failed_queries: failed };
}

export function summarizeFindEvents(r: FindEventsResult): string {
  if (!r.events.length) return `no upcoming events before ${r.window.to}${failedNote(r.failed_queries, 2)}`;
  const dated = r.events.filter((e) => e.event_date).length;
  return `found ${r.events.length} upcoming event${r.events.length === 1 ? "" : "s"} (${dated} dated)${failedNote(r.failed_queries, 2)}`;
}
