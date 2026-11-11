import { describe, it, expect, beforeEach } from "vitest";
import { search_web, summarizeSearchWeb } from "../src/tools/search_web.js";
import { HttpError } from "../src/core/errors.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());
const target = { name: "Boris Jabes", company: "Y Combinator", role: "Partner" };

const bio = { results: [
  { url: "https://www.ycombinator.com/people/boris-jabes", title: "Boris Jabes - Y Combinator", publishedDate: "2025-03-01T00:00:00.000Z", text: "Boris Jabes is a Group Partner at YC. He co-founded Census.", highlights: ["Boris Jabes co-founded Census, acquired by Fivetran."] },
  { url: "https://unrelated.com/a", title: "Something else", text: "no name here" },
] };
const interviews = { results: [
  { url: "https://www.ycombinator.com/people/boris-jabes/", title: "dup" }, // duplicate URL with trailing slash
  { url: "https://blog.example.com/q-and-a", title: "Q&A: Boris Jabes on reverse ETL", publishedDate: "not a date", text: null, highlights: null },
  { url: "https://www.youtube.com/watch?v=abc", title: null, text: "Boris Jabes at Data Council" },
] };
const essays = { results: [
  { url: "https://www.getcensus.com/blog/why-reverse-etl", title: "Why reverse ETL", author: "Boris Jabes", publishedDate: "2021-06-01", highlights: ["The warehouse is the source of truth."] },
] };

function route(_u: string, b: any) {
  if (b.query.includes("biography")) return { json: bio };
  if (b.query.startsWith("interview")) return { json: interviews };
  return { json: essays };
}

describe("search_web", () => {
  it("sends 3 searches with contents and parses bio / interview / essay", async () => {
    const { fetch, calls } = fakeFetch(route);
    const { ctx } = makeCtx(fetch);
    const r = await search_web({ target }, ctx);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.body.numResults).toBeLessThanOrEqual(10);
      expect(c.body.contents.highlights.query).toContain("Boris Jabes");
      expect(c.body.text).toBeUndefined(); // must be nested in contents
    }
    expect(calls[0]!.body.query).toBe("Boris Jabes Partner Y Combinator biography background career");
    expect(calls[0]!.body.contents.text).toEqual({ maxCharacters: 1500 });
    expect(calls[1]!.body.query).toBe("interview with Boris Jabes (Y Combinator)");

    expect(r.items.map((i) => [i.kind, i.url])).toEqual([
      ["bio", "https://www.ycombinator.com/people/boris-jabes"],
      ["interview", "https://blog.example.com/q-and-a"],
      ["interview", "https://www.youtube.com/watch?v=abc"],
      ["essay", "https://www.getcensus.com/blog/why-reverse-etl"],
    ]);
    expect(r.items[0]!.date).toBe("2025-03-01");
    expect(r.items[1]!.date).toBeUndefined(); // invalid date dropped
    expect(r.items[2]!.format).toBe("talk");
    expect(r.items[2]!.title).toBe("youtube.com"); // null title falls back to host
    const f = ctx.findings.byTool("search_web");
    expect(f).toHaveLength(4);
    expect(f[3]).toMatchObject({ kind: "essay", step: "step1", quote: "The warehouse is the source of truth.", date: "2021-06-01", confidence: "high" });
    expect(summarizeSearchWeb(r)).toBe("found 1 bio page, 2 interviews/talks, 1 essay");
  });

  it("handles an empty response", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await search_web({ target }, ctx);
    expect(r.items).toEqual([]);
    expect(summarizeSearchWeb(r)).toBe("nothing found");
  });

  it("tolerates a response without a results array", async () => {
    const { fetch } = fakeFetch(() => ({ json: { error: "weird" } }));
    const { ctx } = makeCtx(fetch);
    expect((await search_web({ target }, ctx)).items).toEqual([]);
  });

  it("throws HttpError on 500", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, text: "down" }));
    const { ctx } = makeCtx(fetch);
    await expect(search_web({ target }, ctx)).rejects.toBeInstanceOf(HttpError);
  });

  it("uses the keyless MCP endpoint when EXA_API_KEY is missing", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => b.method === "tools/call"
      ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify(essays) }] } } }
      : { json: { jsonrpc: "2.0", id: b.id, result: {} } });
    const { ctx } = makeCtx(fetch, {});
    const r = await search_web({ target }, ctx);
    expect(calls.some((c) => c.url === "https://api.exa.ai/search")).toBe(false);
    expect(r.items.map((i) => i.kind)).toEqual(["essay"]);
  });

  it("an article about someone else with the same first name is ignored", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [{ url: "https://a.com/x", title: "Boris Johnson resigns", text: "Boris Johnson" }] } }));
    const { ctx } = makeCtx(fetch);
    expect((await search_web({ target }, ctx)).items).toEqual([]);
  });
});
