import { describe, it, expect } from "vitest";
import { bothNamed, classifyTie, mutual_ties, shared_affiliations, summarizeMutualTies } from "../src/tools/network_ties.js";
import { actionsFromFinding, LiveActions, type LiveAction } from "../src/leads.js";
import { FindingStore } from "../src/core/findings.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

describe("mutual ties", () => {
  it("reads how two people know each other from the passage naming both", () => {
    expect(classifyTie("Ann Lee and Boris Jabes co-founded Acme in 2012")).toEqual({ strength: 3, tie: "co-founded a company together" });
    expect(classifyTie("Boris Jabes invested in Bo Chen's seed round").strength).toBe(2);
    expect(classifyTie("Speakers: Cy Wu, Boris Jabes").strength).toBe(1);
    expect(bothNamed("Boris Jabes talks. " + "x".repeat(900) + " Ann Lee", "Ann Lee", "Boris Jabes")).toBeUndefined(); // far apart
    expect(bothNamed("Ann Lee worked with Boris Jabes", "Ann Lee", "Boris Jabes")).toContain("worked with");
  });

  it("keeps the strongest tie per mutual, ignores pages that don't name both, and saves findings", async () => {
    resetExaMcpSession();
    const { fetch } = fakeFetch((_url, body) => {
      const q = String(body?.query ?? "");
      if (q.startsWith("Ann Lee")) return { json: { results: [
        { url: "https://a.com/1", title: "Speakers", text: "Ann Lee and Boris Jabes spoke on a panel." },
        { url: "https://a.com/2", title: "Acme", text: "Ann Lee co-founded Acme with Boris Jabes." },
      ] } };
      if (q.startsWith("Bo Chen")) return { json: { results: [{ url: "https://b.com", title: "Bo", text: "Bo Chen writes about startups." }] } };
      return { json: { results: [] } };
    });
    const { ctx } = makeCtx(fetch, { EXA_API_KEY: "k" });
    const r = await mutual_ties({ target: { name: "Boris Jabes" }, mutuals: ["Ann Lee", "Bo Chen", "Solo"] }, ctx);
    expect(r.checked).toBe(2); // "Solo" isn't a full name
    expect(r.ties).toEqual([expect.objectContaining({ mutual: "Ann Lee", strength: 3, url: "https://a.com/2" })]);
    expect(ctx.findings.all().filter((f) => f.kind === "mutual_tie")).toHaveLength(1);
    expect(summarizeMutualTies(r)).toBe("1 of 2 mutuals know them: Ann Lee (co-founded a company together)");
  });

  it("finds a background you share", async () => {
    resetExaMcpSession();
    const { fetch } = fakeFetch(() => ({ json: { results: [{ url: "https://u.edu/alumni", title: "Alumni", text: "Boris Jabes studied at Waterloo University." }] } }));
    const { ctx } = makeCtx(fetch, { EXA_API_KEY: "k" });
    const r = await shared_affiliations({ target: { name: "Boris Jabes" }, affiliations: ["Waterloo University", "Mars Academy"] }, ctx);
    expect(r.shared.map((s) => s.affiliation)).toEqual(["Waterloo University"]); // the same page doesn't name Mars Academy
  });
});

describe("network cards", () => {
  const f = (kind: string, data: Record<string, unknown>, id = "f1") =>
    ({ id, step: "step2" as const, tool: "t", kind, claim: "c", source_url: "https://example.com/p", confidence: "high" as const, data });

  it("upgrades a mutual's intro card in place when the web shows how they know the target", () => {
    const got: LiveAction[] = [];
    const live = new LiveActions(() => "Boris Jabes", (a) => got.push(a));
    live.consider(f("mutuals", { mutual_connections: ["Ann Lee", "Bo Chen"] }));
    live.consider(f("mutual_tie", { mutual: "Ann Lee", tie: "worked together", strength: 3 }, "f2"));
    live.consider(f("mutual_tie", { mutual: "Ann Lee", tie: "named together online", strength: 1 }, "f3")); // weaker: no change
    expect(got.map((a) => [a.id, a.p])).toEqual([["live1", 0.3], ["live2", 0.3], ["live1", 0.5]]);
    expect(live.list).toHaveLength(2);
    expect(live.list[0]!.how[0]).toContain("worked together");
    expect(live.list[0]!.evidence).toEqual(["f1", "f2"]);
  });

  it("a shared background becomes a find-a-mutual card", () => {
    const [a] = actionsFromFinding(f("shared_affiliation", { affiliation: "Waterloo" }), "Boris Jabes");
    expect(a).toMatchObject({ type: "network_first", title: "Find someone from Waterloo who knows Boris", contact: "Waterloo" });
  });
});
