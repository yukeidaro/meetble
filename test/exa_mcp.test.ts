import { describe, it, expect, beforeEach } from "vitest";
import { parseMcpResults, parseRpcBody, resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { exaSearch } from "../src/tools/exa.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());

describe("exa MCP fallback", () => {
  it("parses SSE bodies", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n';
    expect(parseRpcBody(body).result.ok).toBe(1);
  });
  it("parses text blocks and JSON payloads", () => {
    const txt = "Title: A\nURL: https://a.com/x\nPublished Date: 2026-11-01\nText: hello\n\nTitle: B\nURL: notaurl\n";
    expect(parseMcpResults(txt)).toEqual([{ url: "https://a.com/x", title: "A", publishedDate: "2026-11-01", author: null, text: "hello" }]);
    expect(parseMcpResults('{"results":[{"url":"https://b.com","title":"B"}]}')[0]?.url).toBe("https://b.com");
  });
  it("parses the hosted server's real output (Published/Author N/A, Highlights section, --- separators)", () => {
    // Format from exa-mcp-server src/tools/webSearch.ts: Title/URL/Published/Author, then
    // "Highlights:\n..." when highlights exist (else "Text: ..."), results joined by "\n\n---\n\n".
    const txt = [
      "Title: Boris Jabes on agents\nURL: https://a.com/x\nPublished: 2026-11-01T00:00:00.000Z\nAuthor: N/A\nHighlights:\nBoris Jabes: I'm excited about agents.\nContact jane.doe@ycombinator.com",
      "Title: N/A\nURL: https://b.com/y\nPublished: N/A\nAuthor: Jane Doe\nText: body text",
    ].join("\n\n---\n\n");
    expect(parseMcpResults(txt)).toEqual([
      { url: "https://a.com/x", title: "Boris Jabes on agents", publishedDate: "2026-11-01T00:00:00.000Z", author: null,
        text: "Boris Jabes: I'm excited about agents.\nContact jane.doe@ycombinator.com",
        highlights: ["Boris Jabes: I'm excited about agents.", "Contact jane.doe@ycombinator.com"] },
      { url: "https://b.com/y", title: null, publishedDate: null, author: "Jane Doe", text: "body text" },
    ]);
  });
  it("is used when EXA_API_KEY is missing, and applies domain/date filters locally", async () => {
    const { fetch, calls } = fakeFetch((url, body) => {
      if (body.method === "initialize") return { json: { jsonrpc: "2.0", id: body.id, result: {} } };
      if (body.method === "notifications/initialized") return { text: "" };
      return { json: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ results: [
        { url: "https://lu.ma/e1", publishedDate: "2026-11-10" },
        { url: "https://evil-lu.ma.com/e2", publishedDate: "2026-11-10" },
        { url: "https://lu.ma/old", publishedDate: "2026-01-01" },
      ] }) }] } } };
    });
    const { ctx } = makeCtx(fetch, {});
    const r = await exaSearch({ query: "Boris Jabes", includeDomains: ["lu.ma"], startPublishedDate: "2026-11-01" }, ctx);
    expect(r.map((x) => x.url)).toEqual(["https://lu.ma/e1"]);
    expect(calls.every((c) => c.url === "https://mcp.exa.ai/mcp")).toBe(true);
    expect(calls.at(-1)?.body.params.arguments.query).toContain("site:lu.ma");
  });
});

describe("exa MCP concurrency", () => {
  it("runs one initialize for parallel searches", async () => {
    const { fetch, calls } = fakeFetch((url, body) => {
      if (body.method === "initialize") return { json: { jsonrpc: "2.0", id: body.id, result: {} } };
      if (body.method === "notifications/initialized") return { text: "" };
      return { json: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "[]" }] } } };
    });
    const { ctx } = makeCtx(fetch, {});
    await Promise.all([exaSearch({ query: "a" }, ctx), exaSearch({ query: "b" }, ctx), exaSearch({ query: "c" }, ctx)]);
    expect(calls.filter((c) => c.body.method === "initialize").length).toBe(1);
  });
});

describe("exa MCP tool errors", () => {
  it("surfaces isError tool results (e.g. anonymous rate limit) instead of returning no results", async () => {
    const { fetch } = fakeFetch((url, body) => {
      if (body.method === "initialize") return { json: { jsonrpc: "2.0", id: body.id, result: {} } };
      if (body.method === "notifications/initialized") return { text: "" };
      return { json: { jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Search error (429): rate limit exceeded" }] } } };
    });
    const { ctx } = makeCtx(fetch, {});
    await expect(exaSearch({ query: "a" }, ctx)).rejects.toThrow(/rate limit/);
  });
});
