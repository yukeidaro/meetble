import { describe, it, expect, beforeEach } from "vitest";
import { recent_web_mentions, summarizeRecentWebMentions } from "../src/tools/recent_web_mentions.js";
import { HttpError } from "../src/core/errors.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());
// ctx.now() = 2026-11-11T12:00:00Z
const target = { name: "Boris Jabes", company: "Y Combinator" };

const recent = [
  { url: "https://techcrunch.com/2026/11/09/yc", title: "YC's Boris Jabes on the AI batch", publishedDate: "2026-11-09T15:00:00.000Z", highlights: ["Boris Jabes said the batch is the biggest yet."] },
  { url: "https://blog.example.com/p", title: null, publishedDate: "2026-11-04", text: "Thanks to Boris Jabes for the feedback." }, // exactly 7 days ago, day-only
  { url: "https://techcrunch.com/2026/11/09/yc/", title: "dup" },
  { url: "https://old.example.com/a", title: "Boris Jabes", publishedDate: "2026-10-01" }, // API filter ignored: dropped locally
  { url: "https://nodate.example.com/a", title: "Boris Jabes", publishedDate: null },
  { url: "https://bad.example.com/a", title: "Boris Jabes", publishedDate: "yesterday" },
  { url: "https://other.example.com/a", title: "Boris Johnson news", publishedDate: "2026-11-10" },
];

describe("recent_web_mentions", () => {
  it("searches the last 7 days and parses mentions", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { results: recent } }));
    const { ctx } = makeCtx(fetch);
    const r = await recent_web_mentions({ target }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      query: '"Boris Jabes" Y Combinator news',
      numResults: 10,
      startPublishedDate: "2026-11-04T00:00:00.000Z",
      contents: { highlights: { query: "what is said about Boris Jabes" } },
    });
    expect(r.widened).toBe(false);
    expect(r.days).toBe(7);
    expect(r.mentions.map((m) => [m.url, m.date])).toEqual([
      [recent[0]!.url, "2026-11-09"],
      [recent[1]!.url, "2026-11-04"],
    ]);
    expect(r.mentions[1]!.title).toBe("blog.example.com");
    const f = ctx.findings.byTool("recent_web_mentions");
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ kind: "mention", step: "step2", date: "2026-11-09", quote: "Boris Jabes said the batch is the biggest yet.", confidence: "high", data: { window_days: 7 } });
    expect(summarizeRecentWebMentions(r)).toBe("2 mentions in the last 7 days");
  });

  it("widens to 30 days when the last 7 days have nothing", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => (b.startPublishedDate.startsWith("2026-11-04")
      ? { json: { results: [] } }
      : { json: { results: [{ url: "https://a.com/x", title: "Boris Jabes joins panel", publishedDate: "2026-10-20" }] } }));
    const { ctx } = makeCtx(fetch);
    const r = await recent_web_mentions({ target }, ctx);
    expect(calls.map((c) => c.body.startPublishedDate)).toEqual(["2026-11-04T00:00:00.000Z", "2026-10-12T00:00:00.000Z"]);
    expect(r).toMatchObject({ widened: true, days: 30 });
    expect(r.mentions).toHaveLength(1);
    expect(ctx.findings.all()[0]!.data).toEqual({ window_days: 30 });
    expect(summarizeRecentWebMentions(r)).toBe("none in 7 days; 1 mention in the last 30 days");
  });

  it("handles an empty response (both windows)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await recent_web_mentions({ target }, ctx);
    expect(calls).toHaveLength(2);
    expect(r).toEqual({ mentions: [], days: 30, widened: true });
    expect(summarizeRecentWebMentions(r)).toBe("no mentions in the last 30 days");
  });

  it("throws HttpError on 500", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, text: "down" }));
    const { ctx } = makeCtx(fetch);
    await expect(recent_web_mentions({ target }, ctx)).rejects.toBeInstanceOf(HttpError);
  });

  it("uses the keyless MCP endpoint when EXA_API_KEY is missing (date filter applied locally)", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => b.method === "tools/call"
      ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify({ results: recent }) }] } } }
      : { json: { jsonrpc: "2.0", id: b.id, result: {} } });
    const { ctx } = makeCtx(fetch, {});
    const r = await recent_web_mentions({ target }, ctx);
    expect(calls.every((c) => c.url === "https://mcp.exa.ai/mcp")).toBe(true);
    expect(r.mentions.map((m) => m.url)).toEqual([recent[0]!.url, recent[1]!.url]);
  });
});
