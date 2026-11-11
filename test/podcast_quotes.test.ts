import { describe, it, expect, beforeEach } from "vitest";
import { podcast_quotes, summarizePodcastQuotes, classifyQuote, extractQuotes, PODCAST_DOMAINS } from "../src/tools/podcast_quotes.js";
import { HttpError } from "../src/core/errors.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());
const target = { name: "Boris Jabes", company: "Census" };

const transcript = [
  "Host: Welcome back. Today I'm here with Boris Jabes, the co-founder of Census. What are you looking for in founders?",
  "Boris: I'm looking for founders who have an unfair insight into a boring market. That is what I want to see in a pitch.",
  "Host: What frustrates you about data tooling?",
  "Boris Jabes: Honestly, I hate that every company rebuilds the same broken pipelines over and over.",
].join("\n");

const ep1 = {
  url: "https://www.youtube.com/watch?v=xyz", title: "Boris Jabes on building Census | The Data Podcast Ep. 42", publishedDate: "2024-05-02T00:00:00Z",
  text: transcript,
  highlights: [
    "I remember the early days when we started Census in a tiny office and nobody understood reverse ETL.",
    "He said the market was huge.",
    "Is this the end of the modern data stack?",
  ],
};
const ep2 = {
  url: "https://podcasts.apple.com/us/podcast/ep-7/id1", title: "Ep 7: Data activation with Boris Jabes", publishedDate: null, text: null,
  highlights: ['"Data teams should be treated like product teams, with real customers," Jabes said.'],
};
const article = { url: "https://news.example.com/story", title: "Funding news roundup", text: "Boris Jabes was mentioned." }; // not an episode

describe("podcast_quotes", () => {
  it("queries podcast domains + general, extracts the target's own words", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => (b.includeDomains ? { json: { results: [ep1, ep2] } } : { json: { results: [ep1, article] } }));
    const { ctx } = makeCtx(fetch);
    const r = await podcast_quotes({ target }, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.query).toBe('"Boris Jabes" podcast interview');
    expect(calls[0]!.body.includeDomains).toEqual(PODCAST_DOMAINS);
    expect(calls[0]!.body.contents.text).toEqual({ maxCharacters: 6000 });
    expect(calls[0]!.body.contents.highlights.query).toContain("Boris Jabes");
    expect(calls[1]!.body.includeDomains).toBeUndefined();
    expect(calls[1]!.body.query).toBe("Boris Jabes Census podcast episode guest");

    expect(r.episodes.map((e) => e.url)).toEqual([ep1.url, ep2.url]); // ep1 deduped, article dropped
    expect(r.episodes[0]!.date).toBe("2024-05-02");
    const texts = r.quotes.map((q) => q.text);
    expect(texts).toContain("I'm looking for founders who have an unfair insight into a boring market.");
    expect(texts).toContain("Honestly, I hate that every company rebuilds the same broken pipelines over and over.");
    expect(texts).toContain("Data teams should be treated like product teams, with real customers");
    // host's words, third-person sentences and questions are excluded
    expect(texts.some((t) => t.startsWith("Welcome back"))).toBe(false);
    expect(texts.some((t) => t.includes("He said"))).toBe(false);
    expect(texts.some((t) => t.endsWith("?"))).toBe(false);
    const byText = (s: string) => r.quotes.find((q) => q.text.startsWith(s))!;
    expect(byText("I'm looking for").theme).toBe("looking_for");
    expect(byText("Honestly, I hate").theme).toBe("frustrates");
    expect(byText("Data teams").how).toBe("attributed");

    const saved = ctx.findings.byTool("podcast_quotes").filter((f) => f.kind === "quote");
    expect(saved.length).toBe(r.quotes.length);
    expect(saved[0]).toMatchObject({ step: "step1", source_url: ep1.url, date: "2024-05-02" });
    expect(saved[0]!.quote).toBeTruthy();
    expect(saved[0]!.data?.theme).toBeTruthy();
    expect(summarizePodcastQuotes(r)).toBe(`found 2 podcasts/talks, ${r.quotes.length} quotes`);
  });

  it("first-person highlights count only on pages titled with the target, at low confidence", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [ep1] } }));
    const { ctx } = makeCtx(fetch);
    const r = await podcast_quotes({ target }, ctx);
    const story = r.quotes.find((q) => q.text.startsWith("I remember"))!;
    expect(story).toMatchObject({ how: "first_person", theme: "repeated_story" });
    expect(ctx.findings.all().find((f) => f.quote === story.text)?.confidence).toBe("low");
  });

  it("handles an empty response", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await podcast_quotes({ target }, ctx);
    expect(r).toEqual({ episodes: [], quotes: [], failed_queries: 0 });
    expect(summarizePodcastQuotes(r)).toBe("nothing found");
  });

  it("throws HttpError on 500", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, text: "down" }));
    const { ctx } = makeCtx(fetch);
    await expect(podcast_quotes({ target }, ctx)).rejects.toBeInstanceOf(HttpError);
  });

  it("uses the keyless MCP endpoint when EXA_API_KEY is missing", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => b.method === "tools/call"
      ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify({ results: [ep2] }) }] } } }
      : { json: { jsonrpc: "2.0", id: b.id, result: {} } });
    const { ctx } = makeCtx(fetch, {});
    const r = await podcast_quotes({ target }, ctx);
    expect(calls.every((c) => c.url === "https://mcp.exa.ai/mcp")).toBe(true);
    expect(r.quotes).toHaveLength(1);
  });
});

describe("quote helpers", () => {
  it("classifyQuote heuristic", () => {
    expect(classifyQuote("We'd love to see more founders in dev tools.")).toBe("looking_for");
    expect(classifyQuote("It's so frustrating when data is stale.")).toBe("frustrates");
    expect(classifyQuote("I'm really excited about AI agents.")).toBe("excites");
    expect(classifyQuote("Years ago, we started in a garage.")).toBe("repeated_story");
    expect(classifyQuote("Pricing should be simple.")).toBe("other");
  });
  it("extractQuotes survives missing fields", () => {
    expect(extractQuotes({ url: "https://a.com", title: null, text: undefined, highlights: undefined }, "Boris Jabes")).toEqual([]);
    expect(extractQuotes({ url: "https://a.com" }, "")).toEqual([]);
  });
  it("does not treat another person's speaker label as the target", () => {
    const r = { url: "https://a.com", title: "x", text: "Borisov: I think the warehouse is the center of everything we do today." };
    expect(extractQuotes(r, "Boris Jabes")).toEqual([]);
  });
});
