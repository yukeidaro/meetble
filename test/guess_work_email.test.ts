import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyLocal,
  extractAddresses,
  guess_work_email,
  inferPattern,
  splitName,
  summarizeGuessWorkEmail,
} from "../src/tools/guess_work_email.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";
import type { Target } from "../src/core/types.js";

const boris: Target = { name: "Boris Jabes", company: "Census", company_domain: "getcensus.com" };
const NO_HUNTER = { EXA_API_KEY: "k" };

beforeEach(() => resetExaMcpSession());

/** Fake replies for Exa's keyless MCP endpoint (used when EXA_API_KEY is unset). */
function mcpReply(body: any, results: unknown[]) {
  if (body?.method === "initialize") return { json: { jsonrpc: "2.0", id: body.id, result: {} } };
  if (body?.method === "notifications/initialized") return { text: "" };
  return { json: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ results }) }] } } };
}


function exaWith(results: Array<{ url: string; title?: string; text?: string }>) {
  return fakeFetch((url) => (url === "https://api.exa.ai/search" ? { json: { results } } : { status: 500, text: "unexpected" }));
}

describe("helpers", () => {
  it("extracts only addresses at exactly the domain", () => {
    const t = "a.b@getcensus.com, c@eng.getcensus.com, d@getcensus.com.evil.io, e@notgetcensus.com, F.G@GetCensus.com.";
    expect(extractAddresses(t, "getcensus.com")).toEqual(["a.b@getcensus.com", "f.g@getcensus.com"]);
  });

  it("splits names for email locals", () => {
    expect(splitName("Seán O'Brien")).toEqual({ first: "sean", last: "obrien" });
    expect(splitName("Jean-Luc Picard")).toEqual({ first: "jeanluc", last: "picard" });
    expect(splitName("Madonna")).toEqual({ first: "madonna", last: undefined });
  });

  it("classifies locals by nearby names, else only by unambiguous shapes", () => {
    expect(classifyLocal("jdoe", [{ first: "jane", last: "doe" }])).toBeUndefined(); // flast is not a supported pattern
    expect(classifyLocal("jane", [{ first: "jane", last: "doe" }])).toBe("first");
    expect(classifyLocal("janedoe", [{ first: "jane", last: "doe" }])).toBe("firstlast");
    expect(classifyLocal("jane.doe", [])).toBe("first.last");
    expect(classifyLocal("j.doe", [])).toBe("f.last");
    expect(classifyLocal("jane_doe", [])).toBe("first_last");
    expect(classifyLocal("jane", [])).toBeUndefined();
    expect(classifyLocal("press", [{ first: "press", last: "team" }])).toBeUndefined();
  });

  it("infers pattern with 0, 1 and 2+ examples and dedupes repeated addresses", () => {
    expect(inferPattern([{ url: "https://a.com", text: "write to info@x.com" }], "x.com").pattern).toBeUndefined();
    const one = inferPattern([{ url: "https://a.com", text: "jane.doe@x.com" }], "x.com");
    expect(one.pattern).toBe("first.last");
    expect(one.examples.length).toBe(1);
    const dup = inferPattern(
      [
        { url: "https://a.com", text: "jane.doe@x.com" },
        { url: "https://b.com", text: "Jane.Doe@x.com" },
      ],
      "x.com",
    );
    expect(dup.examples.length).toBe(1);
    const overlap = inferPattern([{ url: "https://a.com", text: "Contact Jane Doe: jane@x.com" }], "x.com");
    expect(overlap.pattern).toBe("first");
    const tie = inferPattern([{ url: "https://a.com", text: "jane.doe@x.com and bob_ray@x.com" }], "x.com");
    expect(tie.tie).toBe(true);
  });
});

describe("guess_work_email: pattern fallback", () => {
  it("skips when no domain and no Hunter key", async () => {
    const { fetch, calls } = exaWith([]);
    const { ctx } = makeCtx(fetch, NO_HUNTER);
    const r = await guess_work_email({ target: { name: "Boris Jabes" } }, ctx);
    expect(r).toMatchObject({ skipped: true, method: "none" });
    expect(r.reason).toMatch(/domain/);
    expect(calls.length).toBe(0);
    expect(summarizeGuessWorkEmail(r)).toMatch(/^skipped/);
  });

  it("sends includeText @domain and returns none with 0 examples (no finding)", async () => {
    const { fetch, calls } = exaWith([{ url: "https://getcensus.com/contact", text: "Email hello@getcensus.com" }]);
    const { ctx } = makeCtx(fetch, NO_HUNTER);
    const r = await guess_work_email({ target: boris }, ctx);
    expect(calls[0]!.body.includeText).toEqual(["@getcensus.com"]);
    expect(calls[0]!.body.contents).toBeDefined();
    expect(r).toMatchObject({ method: "none", confidence: "low", domain: "getcensus.com", evidence_urls: [] });
    expect(r.email).toBeUndefined();
    expect(ctx.findings.all()).toEqual([]);
  });

  it("1 example -> low confidence, finding sourced to that page", async () => {
    const { fetch } = exaWith([{ url: "https://blog.example.com/p", text: "Contact Jane Doe (jane.doe@getcensus.com)." }]);
    const { ctx } = makeCtx(fetch, NO_HUNTER);
    const r = await guess_work_email({ target: boris }, ctx);
    expect(r).toMatchObject({
      email: "boris.jabes@getcensus.com",
      confidence: "low",
      method: "pattern",
      pattern: "first.last",
      evidence_urls: ["https://blog.example.com/p"],
    });
    const f = ctx.findings.all();
    expect(f.length).toBe(1);
    expect(f[0]).toMatchObject({ kind: "email", step: "step1", source_url: "https://blog.example.com/p", confidence: "low" });
    expect(f[0]!.claim).toMatch(/not verified/);
  });

  it("2+ agreeing examples -> medium; name-resolved 'first' pattern beats an outlier", async () => {
    const { fetch } = exaWith([
      { url: "https://a.com/1", text: "Talk to Jane Doe at jane@getcensus.com" },
      { url: "https://b.com/2", text: "Sam Lee — sam@getcensus.com" },
      { url: "https://c.com/3", text: "kim.park@getcensus.com" },
    ]);
    const { ctx } = makeCtx(fetch, NO_HUNTER);
    const r = await guess_work_email({ target: boris }, ctx);
    expect(r).toMatchObject({ email: "boris@getcensus.com", pattern: "first", confidence: "medium", method: "pattern" });
    expect(r.examples).toEqual(["jane@getcensus.com", "sam@getcensus.com"]);
    expect(r.evidence_urls).toEqual(["https://a.com/1", "https://b.com/2"]);
    expect(summarizeGuessWorkEmail(r)).toBe("boris@getcensus.com (pattern first from 2 examples, medium confidence, unverified)");
  });

  it("no keys at all but a domain: uses the keyless Exa MCP search and filters by includeText locally", async () => {
    const { fetch, calls } = fakeFetch((url, body) => {
      expect(url).toBe("https://mcp.exa.ai/mcp");
      return mcpReply(body, [
        { url: "https://a.com/1", text: "jane.doe@getcensus.com and bob.ray@getcensus.com" },
        { url: "https://b.com/2", text: "no addresses here" },
      ]);
    });
    const { ctx } = makeCtx(fetch, {});
    const r = await guess_work_email({ target: boris }, ctx);
    expect(calls.every((c) => c.url === "https://mcp.exa.ai/mcp")).toBe(true);
    expect(r).toMatchObject({ method: "pattern", email: "boris.jabes@getcensus.com", confidence: "medium", evidence_urls: ["https://a.com/1"] });
  });

  it("surfaces a search failure when there is no Hunter fallback", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, text: "bad key" }));
    const { ctx } = makeCtx(fetch, NO_HUNTER);
    await expect(guess_work_email({ target: boris }, ctx)).rejects.toThrow(/exa HTTP 401/);
  });
});

describe("guess_work_email: Hunter", () => {
  it("happy path: GET with domain/first/last, key in header not URL", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: {
        data: {
          email: "boris@getcensus.com",
          score: 96,
          domain: "getcensus.com",
          sources: [{ uri: "https://getcensus.com/team" }, { uri: "not-a-url" }],
          verification: { status: "valid" },
        },
      },
    }));
    const { ctx } = makeCtx(fetch, { HUNTER_API_KEY: "secret-hunter" });
    const r = await guess_work_email({ target: boris }, ctx);
    expect(calls.length).toBe(1);
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.hunter.io/v2/email-finder");
    expect(u.searchParams.get("domain")).toBe("getcensus.com");
    expect(u.searchParams.get("first_name")).toBe("boris");
    expect(u.searchParams.get("last_name")).toBe("jabes");
    expect(calls[0]!.url).not.toContain("secret-hunter");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.body).toBeUndefined();
    expect((calls[0]!.init?.headers as Record<string, string>)["x-api-key"]).toBe("secret-hunter");
    expect(r).toMatchObject({ email: "boris@getcensus.com", method: "hunter", confidence: "high", hunter_score: 96, evidence_urls: ["https://getcensus.com/team"] });
    expect(ctx.findings.all()[0]).toMatchObject({ kind: "email", source_url: "https://getcensus.com/team" });
  });

  it("Hunter answer without sources is returned but not saved as a finding", async () => {
    const { fetch } = fakeFetch(() => ({ json: { data: { email: "boris@getcensus.com", score: 60, sources: [] } } }));
    const { ctx } = makeCtx(fetch, { HUNTER_API_KEY: "h" });
    const r = await guess_work_email({ target: boris }, ctx);
    expect(r).toMatchObject({ email: "boris@getcensus.com", confidence: "low", evidence_urls: [] });
    expect(ctx.findings.all()).toEqual([]);
  });

  it("404 falls back to pattern search", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.startsWith("https://api.hunter.io/")) return { status: 404, text: '{"errors":[]}' };
      return { json: { results: [{ url: "https://a.com", text: "jane.doe@getcensus.com bob.ray@getcensus.com" }] } };
    });
    const { ctx } = makeCtx(fetch, { HUNTER_API_KEY: "h", EXA_API_KEY: "k" });
    const r = await guess_work_email({ target: boris }, ctx);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["api.hunter.io", "api.exa.ai"]);
    expect(r).toMatchObject({ method: "pattern", email: "boris.jabes@getcensus.com", confidence: "medium" });
    expect(r.hunter_error).toBeUndefined();
  });

  it("empty Hunter data -> pattern search; reason mentions both", async () => {
    const { fetch } = fakeFetch((url) =>
      url.startsWith("https://api.hunter.io/") ? { json: { data: { email: null, score: null, sources: [] } } } : { json: { results: [] } },
    );
    const { ctx } = makeCtx(fetch, { HUNTER_API_KEY: "h", EXA_API_KEY: "k" });
    const r = await guess_work_email({ target: boris }, ctx);
    expect(r).toMatchObject({ method: "none", evidence_urls: [] });
    expect(r.email).toBeUndefined();
    expect(r.reason).toBe("Hunter found no match; no personal addresses at @getcensus.com found publicly");
    expect(summarizeGuessWorkEmail(r)).toMatch(/^no work email/);
    expect(ctx.findings.all()).toEqual([]);
  });

  it("Hunter no match + search failure -> none with reason, not a crash", async () => {
    const { fetch } = fakeFetch((url) =>
      url.startsWith("https://api.hunter.io/") ? { status: 404, text: "{}" } : { status: 401, text: "bad" },
    );
    const { ctx } = makeCtx(fetch, { HUNTER_API_KEY: "h", EXA_API_KEY: "k" });
    const r = await guess_work_email({ target: boris }, ctx);
    expect(r.method).toBe("none");
    expect(r.reason).toBe("Hunter found no match; pattern search failed (exa error 401)");
  });

  it("Hunter 401 with a domain falls back and reports the error", async () => {
    const { fetch } = fakeFetch((url) =>
      url.startsWith("https://api.hunter.io/") ? { status: 401, text: "bad key" } : { json: { results: [] } },
    );
    const { ctx } = makeCtx(fetch, { HUNTER_API_KEY: "h", EXA_API_KEY: "k" });
    const r = await guess_work_email({ target: boris }, ctx);
    expect(r.hunter_error).toBe("hunter error 401");
    expect(r.method).toBe("none");
  });

  it("uses company name when there is no domain; skipped with neither", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { data: null } }));
    const { ctx } = makeCtx(fetch, { HUNTER_API_KEY: "h" });
    const r = await guess_work_email({ target: { name: "Boris Jabes", company: "Y Combinator" } }, ctx);
    expect(new URL(calls[0]!.url).searchParams.get("company")).toBe("Y Combinator");
    expect(r.method).toBe("none");
    const r2 = await guess_work_email({ target: { name: "Boris Jabes" } }, ctx);
    expect(r2.skipped).toBe(true);
    expect(calls.length).toBe(1);
  });
});

import { isSearchEngineUrl, summarizeGuessWorkEmail as sgwe } from "../src/tools/guess_work_email.js";
describe("live-run regressions (email)", () => {
  it("search-engine query URLs are not evidence", () => {
    expect(isSearchEngineUrl("https://www.google.com/search?q=site:linkedin.com%20boris")).toBe(true);
    expect(isSearchEngineUrl("https://www.google.com/about")).toBe(false);
    expect(isSearchEngineUrl("https://ycombinator.com/people")).toBe(false);
  });
  it("summary names Hunter's own check instead of a contradictory 'unverified'", () => {
    expect(sgwe({ email: "boris@ycombinator.com", confidence: "medium", method: "hunter", evidence_urls: [], hunter_score: 96, hunter_verification: "valid" }))
      .toBe("boris@ycombinator.com (Hunter score 96, medium confidence, Hunter check: valid)");
  });
});
