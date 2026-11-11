import { describe, it, expect, beforeEach } from "vitest";
import { resolve_target, summarizeResolveTarget, xHandleFromUrl, parseProfileTitle, linkedinProfile, dedupeByUrl, toIsoDate, mentionsName } from "../src/tools/resolve_target.js";
import { HttpError } from "../src/core/errors.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());

const people = {
  results: [
    { url: "https://www.linkedin.com/in/borisjabes/", title: "Boris Jabes - Partner at Y Combinator | LinkedIn", publishedDate: null, text: "Partner at Y Combinator. Previously co-founder and CEO of Census (acquired by Fivetran)." },
    { url: "https://www.ycombinator.com/people/boris-jabes", title: "Boris Jabes | Y Combinator", text: "Boris is a Group Partner at YC." },
    { url: "https://example.com/unrelated", title: null },
  ],
};
const xres = {
  results: [
    { url: "https://x.com/someone/status/1234567890", title: "Someone on X: great chat with Boris Jabes", text: "Boris Jabes" },
    { url: "https://x.com/borisjabes", title: "Boris Jabes (@borisjabes) / X", text: "Partner @ycombinator" },
  ],
};
const sites = { results: [{ url: "https://borisjabes.com/about", title: "About Boris Jabes", text: "I am Boris Jabes." }] };

function route(url: string, body: any) {
  if (body.category === "people") return { json: people };
  if (body.includeDomains) return { json: xres };
  return { json: sites };
}

describe("resolve_target", () => {
  it("sends people / X / personal-site searches and resolves the target", async () => {
    const { fetch, calls } = fakeFetch(route);
    const { ctx } = makeCtx(fetch);
    const r = await resolve_target({ name: "Boris Jabes", hint: "YC partner, Census co-founder" }, ctx);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === "https://api.exa.ai/search")).toBe(true);
    const p = calls.find((c) => c.body.category === "people")!.body;
    expect(p.query).toBe("Boris Jabes YC partner, Census co-founder");
    expect(p.numResults).toBeLessThanOrEqual(10);
    expect(p.startPublishedDate).toBeUndefined(); // people category rejects date filters
    expect(p.excludeDomains).toBeUndefined();
    expect(p.contents).toEqual({ text: { maxCharacters: 1000 } });
    expect(calls.find((c) => c.body.includeDomains)!.body.includeDomains).toEqual(["x.com", "twitter.com"]);
    expect(calls.find((c) => c.body.category === "personal site")).toBeTruthy();

    expect(r.target).toEqual({
      name: "Boris Jabes",
      role: "Partner",
      company: "Y Combinator",
      company_domain: "ycombinator.com",
      linkedin_url: "https://www.linkedin.com/in/borisjabes",
      x_handle: "borisjabes",
      website: "https://borisjabes.com",
    });
    expect(r.ambiguous).toBe(false);
    expect(r.candidates[0]).toEqual({ name: "Boris Jabes", role: "Partner", company: "Y Combinator", url: "https://www.linkedin.com/in/borisjabes" });
    const kinds = ctx.findings.byTool("resolve_target").map((f) => f.kind);
    expect(kinds).toContain("identity");
    expect(summarizeResolveTarget(r)).toContain("Partner at Y Combinator");
  });

  it("does not take the handle from a status URL", async () => {
    const { fetch } = fakeFetch((u, b) => (b.includeDomains ? { json: { results: [xres.results[0]] } } : { json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await resolve_target({ name: "Boris Jabes" }, ctx);
    expect(r.target.x_handle).toBeUndefined();
  });

  it("flags ambiguity when two different LinkedIn people share the name", async () => {
    const { fetch } = fakeFetch((u, b) => b.category === "people" ? { json: { results: [
      { url: "https://www.linkedin.com/in/jane-doe-1", title: "Jane Doe - CEO at Acme | LinkedIn" },
      { url: "https://uk.linkedin.com/in/jane-doe-2", title: "Jane Doe - Nurse at NHS | LinkedIn" },
    ] } } : { json: { results: [] } });
    const { ctx } = makeCtx(fetch);
    const r = await resolve_target({ name: "Jane Doe" }, ctx);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
    expect(summarizeResolveTarget(r)).toContain("ambiguous");
  });

  it("a hint disambiguates", async () => {
    const { fetch } = fakeFetch((u, b) => b.category === "people" ? { json: { results: [
      { url: "https://www.linkedin.com/in/jane-doe-1", title: "Jane Doe - CEO at Acme | LinkedIn" },
      { url: "https://www.linkedin.com/in/jane-doe-2", title: "Jane Doe - Nurse at NHS | LinkedIn" },
    ] } } : { json: { results: [] } });
    const { ctx } = makeCtx(fetch);
    const r = await resolve_target({ name: "Jane Doe", hint: "Acme" }, ctx);
    expect(r.ambiguous).toBe(false);
    expect(r.target.company).toBe("Acme");
  });

  it("handles an empty response", async () => {
    const { fetch } = fakeFetch(() => ({ json: { results: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await resolve_target({ name: "Boris Jabes" }, ctx);
    expect(r).toEqual({ target: { name: "Boris Jabes" }, candidates: [], ambiguous: false, failed_queries: 0 });
    expect(summarizeResolveTarget(r)).toBe("no profile found");
  });

  it("throws HttpError when every search returns 500", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 500, text: "boom" }));
    const { ctx } = makeCtx(fetch);
    await expect(resolve_target({ name: "Boris Jabes" }, ctx)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(9); // 3 searches x (1 + 2 retries)
  });

  it("keeps partial results when one search fails", async () => {
    const { fetch } = fakeFetch((u, b) => (b.category === "people" ? { json: people } : { status: 400, text: "bad" }));
    const { ctx } = makeCtx(fetch);
    const r = await resolve_target({ name: "Boris Jabes" }, ctx);
    expect(r.failed_queries).toBe(2);
    expect(r.target.company).toBe("Y Combinator");
    expect(summarizeResolveTarget(r)).toContain("2 of 3 searches failed");
  });

  it("without EXA_API_KEY falls back to the keyless MCP endpoint", async () => {
    const { fetch, calls } = fakeFetch((u, b) => {
      if (b.method === "tools/call") return { json: { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify(people) }] } } };
      return { json: { jsonrpc: "2.0", id: b.id, result: {} } };
    });
    const { ctx } = makeCtx(fetch, {});
    const r = await resolve_target({ name: "Boris Jabes" }, ctx);
    expect(calls.every((c) => c.url === "https://mcp.exa.ai/mcp")).toBe(true);
    expect(r.target.linkedin_url).toBe("https://www.linkedin.com/in/borisjabes");
  });

  it("rejects an empty name", async () => {
    const { ctx } = makeCtx(fakeFetch(() => ({})).fetch);
    await expect(resolve_target({ name: "  " }, ctx)).rejects.toThrow(/name is required/);
  });
});

describe("resolve_target helpers", () => {
  it("xHandleFromUrl", () => {
    expect(xHandleFromUrl("https://twitter.com/borisjabes")).toBe("borisjabes");
    expect(xHandleFromUrl("https://x.com/@borisjabes/")).toBe("borisjabes");
    expect(xHandleFromUrl("https://x.com/borisjabes/status/1")).toBeUndefined();
    expect(xHandleFromUrl("https://x.com/intent/user?screen_name=borisjabes")).toBeUndefined();
    expect(xHandleFromUrl("https://x.com/home")).toBeUndefined();
    expect(xHandleFromUrl("https://notx.com/borisjabes")).toBeUndefined();
    expect(xHandleFromUrl("not a url")).toBeUndefined();
  });
  it("linkedinProfile only accepts /in/ URLs", () => {
    expect(linkedinProfile("https://uk.linkedin.com/in/BorisJabes/?trk=x")?.url).toBe("https://www.linkedin.com/in/borisjabes");
    expect(linkedinProfile("https://www.linkedin.com/company/census")).toBeUndefined();
    expect(linkedinProfile("https://evil-linkedin.com/in/x")).toBeUndefined();
  });
  it("parseProfileTitle", () => {
    expect(parseProfileTitle("Boris Jabes - Partner at Y Combinator | LinkedIn")).toEqual({ name: "Boris Jabes", role: "Partner", company: "Y Combinator" });
    expect(parseProfileTitle("Boris Jabes | Y Combinator")).toEqual({ name: "Boris Jabes", company: "Y Combinator" });
    expect(parseProfileTitle("Boris Jabes – CEO, Census")).toEqual({ name: "Boris Jabes", role: "CEO", company: "Census" });
    expect(parseProfileTitle(null)).toBeUndefined();
  });
  it("dedupeByUrl normalizes www, trailing slash, hash and utm", () => {
    const r = dedupeByUrl([[{ url: "https://www.a.com/x/" }], [{ url: "https://a.com/x#top" }, { url: "https://a.com/x?utm_source=t" }, { url: "https://a.com/y" }]]);
    expect(r.map((t) => [t.r.url, t.q])).toEqual([["https://www.a.com/x/", 0], ["https://a.com/y", 1]]);
  });
  it("toIsoDate validates", () => {
    expect(toIsoDate("2026-11-05T10:00:00.000Z")).toBe("2026-11-05");
    expect(toIsoDate("garbage")).toBeUndefined();
    expect(toIsoDate(null)).toBeUndefined();
    expect(toIsoDate("0001-01-01")).toBeUndefined();
  });
  it("mentionsName needs whole words and ignores accents", () => {
    expect(mentionsName("Interview with BORIS JABES", "Boris Jabes")).toBe(true);
    expect(mentionsName("Borissov Jabesy", "Boris Jabes")).toBe(false);
    expect(mentionsName("José García speaks", "Jose Garcia")).toBe(true);
    expect(mentionsName(null, "Boris Jabes")).toBe(false);
  });
});
