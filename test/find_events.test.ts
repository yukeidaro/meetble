import { describe, it, expect, beforeEach } from "vitest";
import { find_events, summarizeFindEvents, datesInText, detectRole, EVENT_DOMAINS } from "../src/tools/find_events.js";
import { HttpError } from "../src/core/errors.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());
// ctx.now() = 2026-11-11T12:00:00Z
const target = { name: "Boris Jabes", company: "Y Combinator" };
const deadline = "2026-11-20";

const upcoming = { url: "https://lu.ma/ai-dinner", title: "AI Founders Dinner", publishedDate: "2026-10-01",
  text: "Thursday, November 19\n6:00 PM - 9:00 PM\nHosted By\nAlice Chen\nSpeakers\nBoris Jabes\nJoin us for dinner." };
const today = { url: "https://www.eventbrite.com/e/fireside-123", title: "Fireside chat with Boris Jabes - Nov 11, 2026", publishedDate: null, text: null };
const past = { url: "https://lu.ma/old-meetup", title: "Data meetup", publishedDate: "2026-09-01", text: "September 10, 2026. Hosted by Boris Jabes." };
const yesterday = { url: "https://lu.ma/yday", title: "Yesterday's panel", text: "Nov 10 · Panel with Boris Jabes" };
const tooLate = { url: "https://lu.ma/dec", title: "Holiday party", text: "December 20, 2026. Hosted by Boris Jabes" };
const undatedRecent = { url: "https://lu.ma/tbd", title: "Office hours with Boris Jabes", publishedDate: "2026-11-05", text: "Date TBA. Boris Jabes will host office hours." };
const undatedOld = { url: "https://lu.ma/tbd-old", title: "Old page with Boris Jabes", publishedDate: "2025-01-05", text: "Boris Jabes will host." };
const generalArticle = { url: "https://news.com/interview", title: "An interview with Boris Jabes", publishedDate: "2026-11-09", text: "Boris Jabes talks about data." };
const generalEvent = { url: "https://conf.example.com/2026", title: "DataConf 2026 speakers", text: "Join us 2026-11-23. Keynote by Boris Jabes." };

describe("find_events", () => {
  it("queries event sites + general web and keeps only upcoming events in the window", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => (b.includeDomains
      ? { json: { results: [upcoming, today, past, yesterday, tooLate, undatedRecent, undatedOld] } }
      : { json: { results: [generalArticle, generalEvent, upcoming] } }));
    const { ctx } = makeCtx(fetch);
    const r = await find_events({ target, deadline }, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ query: "Boris Jabes event", includeDomains: EVENT_DOMAINS, numResults: 10, contents: { text: { maxCharacters: 3000 } } });
    expect(EVENT_DOMAINS).toEqual(["lu.ma", "luma.com", "eventbrite.com"]);
    expect(calls[1]!.body.includeDomains).toBeUndefined();
    expect(calls[1]!.body.query).toContain("Boris Jabes");

    expect(r.window).toEqual({ from: "2026-11-11", to: "2026-11-23" });
    expect(r.events.map((e) => [e.event_url, e.event_date, e.role])).toEqual([
      [today.url, "2026-11-11", "speaker"],
      [upcoming.url, "2026-11-19", "speaker"],
      [generalEvent.url, "2026-11-23", "speaker"],
      [undatedRecent.url, undefined, "host"],
    ]);
    const f = ctx.findings.byTool("find_events");
    expect(f).toHaveLength(4);
    expect(f.find((x) => x.source_url === upcoming.url)).toMatchObject({ kind: "event", step: "step2", date: "2026-11-19", confidence: "high", data: { event_url: upcoming.url, event_date: "2026-11-19", role: "speaker" } });
    expect(f.find((x) => x.source_url === undatedRecent.url)?.confidence).toBe("low");
    expect(summarizeFindEvents(r)).toBe("found 4 upcoming events (3 dated)");
  });

  it("never returns past events", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [past, yesterday] } }));
    const { ctx } = makeCtx(fetch);
    const r = await find_events({ target, deadline }, ctx);
    expect(r.events).toEqual([]);
    expect(summarizeFindEvents(r)).toBe("no upcoming events before 2026-11-23");
  });

  it("rejects an invalid or past deadline without calling the API", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    await expect(find_events({ target, deadline: "soon" }, ctx)).rejects.toThrow(/invalid deadline/);
    await expect(find_events({ target, deadline: "2026-11-01" }, ctx)).rejects.toThrow(/in the past/);
    expect(calls).toHaveLength(0);
  });

  it("handles an empty response", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    expect((await find_events({ target, deadline }, ctx)).events).toEqual([]);
  });

  it("throws HttpError on 500", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, text: "down" }));
    const { ctx } = makeCtx(fetch);
    await expect(find_events({ target, deadline }, ctx)).rejects.toBeInstanceOf(HttpError);
  });

  it("uses the keyless MCP endpoint when EXA_API_KEY is missing", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => b.method === "tools/call"
      ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify({ results: [upcoming] }) }] } } }
      : { json: { jsonrpc: "2.0", id: b.id, result: {} } });
    const { ctx } = makeCtx(fetch, {});
    const r = await find_events({ target, deadline }, ctx);
    expect(calls.every((c) => c.url === "https://mcp.exa.ai/mcp")).toBe(true);
    expect(r.events.map((e) => e.event_url)).toEqual([upcoming.url]);
  });
});

describe("event helpers", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const days = (s: string) => datesInText(s, now).map((d) => d.toISOString().slice(0, 10));
  it("datesInText", () => {
    expect(days("Nov 19")).toEqual(["2026-11-19"]);
    expect(days("January 5th")).toEqual(["2027-01-05"]); // year-less date in early next year
    expect(days("14 November 2026")).toEqual(["2026-11-14"]);
    expect(days("12/01/2026")).toEqual(["2026-12-01"]);
    expect(days("February 31, 2026 and 2026-13-01")).toEqual([]);
    expect(days("")).toEqual([]);
    // ISO date-times (event JSON-LD / calendar exports): "\b" after the day never matched before "T".
    expect(days("startDate 2026-11-14T18:00:00.000Z")).toEqual(["2026-11-14"]);
  });
  it("detectRole uses the nearest keyword before the name", () => {
    expect(detectRole("Hosted by Alice. Speakers: Boris Jabes", "Boris Jabes")).toBe("speaker");
    expect(detectRole("Hosted By\nBoris Jabes\nAlice", "Boris Jabes")).toBe("host");
    expect(detectRole("Boris Jabes (host)", "Boris Jabes")).toBe("host");
    expect(detectRole("Guests include Boris Jabes", "Boris Jabes")).toBe("attendee");
    expect(detectRole("Boris Jabes", "Boris Jabes")).toBe("unknown");
  });
});

describe("find_events with the user's own events", () => {
  const lumaHtml = `<html><head><title>c0mpiled-18 YC Startup School Hackathon Taipei · Luma</title></head><body>
<h1>c0mpiled-18 Hackathon</h1><p>1st prize: Office Hours with YC Partner Boris Jabes + $3,000</p>
<script id="__NEXT_DATA__">{"event":{"start_at":"2026-11-11T10:00:00.000Z","created_at":"2026-09-01T00:00:00Z"}}</script></body></html>`;

  it("fetches a user event URL, finds the target in the prize text, and dates it from start_at", async () => {
    const { fetch, calls } = fakeFetch((u) => (u.includes("luma.com/compiled") ? { text: lumaHtml } : { json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await find_events({ target, deadline, eventUrls: ["https://luma.com/compiled-poy7", "not a url"] }, ctx);
    expect(calls.filter((c) => c.url.includes("luma.com/compiled"))).toHaveLength(1);
    expect(r.events).toEqual([{ title: "c0mpiled-18 YC Startup School Hackathon Taipei · Luma", event_url: "https://luma.com/compiled-poy7",
      event_date: "2026-11-11", role: "speaker", source: "user_event", role_detail: "office hours" }]);
    expect(ctx.findings.byTool("find_events")[0]!.data).toMatchObject({ user_is_attending: true, role_detail: "office hours" });
  });

  it("drops a user event that does not name the target, and survives an unreachable page", async () => {
    const { fetch } = fakeFetch((u) => (u.includes("other") ? { text: "<title>Other</title><p>No one here</p>" } : u.includes("down") ? { status: 500, text: "x" } : { json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await find_events({ target, deadline, eventUrls: ["https://luma.com/other", "https://luma.com/down"] }, ctx);
    expect(r.events).toEqual([]);
  });
});
