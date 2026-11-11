import { describe, it, expect, beforeEach } from "vitest";
import { find_precedents, summarizeFindPrecedents, detectChannel, detectOutcome } from "../src/tools/find_precedents.js";
import { HttpError } from "../src/core/errors.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());
const target = { name: "Boris Jabes", company: "Y Combinator" };

const blog = {
  url: "https://founder.blog/how-we-raised", title: "How we raised our seed round", publishedDate: "2025-08-10",
  text: "Lots of intro text. ".repeat(30) + "I cold emailed Boris Jabes with a two-line note and a demo link. He replied within an hour and we got a call the next day. Later he invested.",
};
const intro = {
  url: "https://medium.com/@x/story", title: null, publishedDate: "garbage",
  highlights: ["We were introduced by a mutual friend to Boris Jabes, and he backed us a week later."],
};
const noise = { url: "https://news.com/census", title: "Census acquired", text: "Fivetran acquires Census, co-founded by Boris Jabes." };
const otherPerson = { url: "https://other.com/x", title: "Cold email tips", text: "I cold emailed Jane Smith and she replied." };

describe("find_precedents", () => {
  it("queries and extracts channel + outcome", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => (b.query.startsWith("how I got") ? { json: { results: [blog, noise, otherPerson] } } : { json: { results: [intro, blog] } }));
    const { ctx } = makeCtx(fetch);
    const r = await find_precedents({ target }, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.query).toBe("how I got a meeting with Boris Jabes: cold email, intro or event");
    expect(calls[1]!.body.query).toBe("Boris Jabes invested in our startup after we were introduced");
    for (const c of calls) {
      expect(c.body.numResults).toBeLessThanOrEqual(10);
      expect(c.body.contents.text).toEqual({ maxCharacters: 5000 });
      expect(c.body.contents.highlights.query).toContain("Boris Jabes");
    }
    expect(r.precedents.map((p) => [p.url, p.channel, p.outcome])).toEqual([
      [blog.url, "cold_email", "investment"],
      [intro.url, "warm_intro", "investment"],
    ]);
    expect(r.precedents[0]!.date).toBe("2025-08-10");
    expect(r.precedents[1]!.date).toBeUndefined();
    expect(r.precedents[1]!.title).toBe("medium.com");
    const f = ctx.findings.byTool("find_precedents");
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ kind: "precedent", step: "step1", data: { channel: "cold_email", outcome: "investment" } });
    expect(f[0]!.quote).toContain("cold emailed Boris Jabes");
    expect(summarizeFindPrecedents(r)).toBe("found 2 precedents (1 cold email, 1 warm intro)");
  });

  it("handles an empty response", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await find_precedents({ target }, ctx);
    expect(r.precedents).toEqual([]);
    expect(summarizeFindPrecedents(r)).toBe("nothing found");
  });

  it("throws HttpError on 500", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, text: "down" }));
    const { ctx } = makeCtx(fetch);
    await expect(find_precedents({ target }, ctx)).rejects.toBeInstanceOf(HttpError);
  });

  it("reports a partial failure in the note", async () => {
    let n = 0;
    const { fetch } = fakeFetch(() => (++n === 1 ? { status: 401, text: "bad key" } : { json: { results: [intro] } }));
    const { ctx } = makeCtx(fetch);
    const r = await find_precedents({ target }, ctx);
    expect(r.failed_queries).toBe(1);
    expect(summarizeFindPrecedents(r)).toContain("(1 of 2 searches failed)");
  });

  it("uses the keyless MCP endpoint when EXA_API_KEY is missing", async () => {
    const { fetch, calls } = fakeFetch((_u, b) => b.method === "tools/call"
      ? { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify({ results: [blog] }) }] } } }
      : { json: { jsonrpc: "2.0", id: b.id, result: {} } });
    const { ctx } = makeCtx(fetch, {});
    const r = await find_precedents({ target }, ctx);
    expect(calls.every((c) => c.url === "https://mcp.exa.ai/mcp")).toBe(true);
    expect(r.precedents).toHaveLength(1);
  });

  it("ignores a channel phrase far from the target's name", async () => {
    const far = { url: "https://a.com/x", title: "Boris Jabes profile", text: "Boris Jabes runs things. " + "filler words here. ".repeat(60) + "I cold emailed Jane." };
    const { fetch } = fakeFetch(() => ({ json: { results: [far] } }));
    const { ctx } = makeCtx(fetch);
    expect((await find_precedents({ target }, ctx)).precedents).toEqual([]);
  });
});

describe("channel / outcome detection", () => {
  it("detects channels", () => {
    expect(detectChannel("I DM'd him on Twitter")).toBe("cold_dm");
    expect(detectChannel("we met him at Demo Day")).toBe("event");
    expect(detectChannel("nothing relevant")).toBeUndefined();
    expect(detectOutcome("he replied the same day")).toBe("reply");
    expect(detectOutcome("no result")).toBe("unknown");
  });
});
