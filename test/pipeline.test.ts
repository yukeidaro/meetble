import { describe, it, expect, beforeEach } from "vitest";
import { runResearch } from "../src/pipeline.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());

const exaResults = [
  { url: "https://www.linkedin.com/in/borisjabes", title: "Boris Jabes - Partner - Y Combinator | LinkedIn", text: "Boris Jabes is a Partner at Y Combinator. Previously co-founder and CEO of Census." },
  { url: "https://x.com/borisjabes", title: "Boris Jabes (@borisjabes) / X", text: "Partner at YC" },
  { url: "https://www.youtube.com/watch?v=abc", title: "Boris Jabes on data infrastructure | Podcast", publishedDate: "2026-10-01", text: "Boris Jabes: I'm really excited about agents that actually do the work. Host: great." },
];

describe("runResearch end to end (all services faked)", () => {
  it("produces the research.json shape and never throws", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.startsWith("https://api.exa.ai")) return { json: { results: exaResults } };
      if (url.startsWith("https://api.x.ai")) return { json: { output: [{ type: "message", content: [{ type: "output_text", text: '{"posts":[],"inner_circle":[],"topics":[],"posting_hours_utc":[]}', annotations: [] }] }] } };
      if (url.startsWith("https://api.meta.ai")) return { status: 500, text: "down" };
      if (url.startsWith("https://api.hunter.io")) return { status: 404, text: "{}" };
      return { status: 404, text: "not found" };
    });
    const { ctx, events } = makeCtx(fetch);
    const r = await runResearch({ name: "Boris Jabes", deadline: "2026-11-20", offerInventory: [{ offer: "x" }] }, ctx);
    expect(r.goal.deadline).toBe("2026-11-20");
    expect(r.offer_inventory).toHaveLength(1);
    expect(r.findings.every((f) => /^f\d+$/.test(f.id) && /^https?:/.test(f.source_url) && [0, 1, 2].includes(f.step))).toBe(true);
    // every started step ends in a terminal state
    const ids = new Set(events.map((e) => e.id));
    for (const id of ids) expect(events.filter((e) => e.id === id).at(-1)?.status).not.toBe("running");
    expect(ids.size).toBe(13); // 11 API tools + login_check + linkedin_profile (both skipped: no venv); handle found by Exa so no Grok lookup
    // Meta outage is reported, not fatal
    expect(events.find((e) => e.id === "step1.instagram_public" && e.status === "error")).toBeTruthy();
  }, 20000);

  it("runs with no keys at all (keyless Exa, others skipped)", async () => {
    const { fetch } = fakeFetch((url, body) => {
      if (url === "https://mcp.exa.ai/mcp") {
        if (body.method === "initialize") return { json: { jsonrpc: "2.0", id: body.id, result: {} } };
        if (body.method === "notifications/initialized") return { text: "" };
        return { json: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ results: exaResults }) }] } } };
      }
      return { status: 404, text: "" };
    });
    const { ctx, events } = makeCtx(fetch, {});
    const r = await runResearch({ name: "Boris Jabes", deadline: "2026-11-20" }, ctx);
    expect(events.filter((e) => e.id === "step1.x_profile").at(-1)?.status).toBe("skipped");
    expect(events.filter((e) => e.id === "step1.instagram_public").at(-1)?.status).toBe("skipped");
    expect(r.target_id.name).toBeTruthy();
  }, 20000);
});

import { companyFromRole } from "../src/pipeline.js";
describe("companyFromRole", () => {
  it("reads the company from a LinkedIn role or headline", () => {
    expect(companyFromRole("Visiting Partner at Y Combinator")).toBe("Y Combinator");
    expect(companyFromRole("Partner @ Y Combinator | ex-Census")).toBe("Y Combinator");
    expect(companyFromRole("Partner, Y Combinator")).toBe("Y Combinator");
    expect(companyFromRole("Investor")).toBeUndefined();
    expect(companyFromRole(undefined)).toBeUndefined();
  });
});
