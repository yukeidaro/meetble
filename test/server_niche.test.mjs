import { describe, expect, it } from "vitest";
import { findingEvents } from "../server.mjs";

describe("niche details", () => {
  it("routes his own words and other specifics to the niche card with a hint", () => {
    const evs = findingEvents({ findings: [
      { dimension: "podcast", kind: "quote", claim: "Boris on \"Ep 78\": long", quote: "we are looking for teams that ship weekly", data: { theme: "looking_for", episode: "Ep 78" }, source_url: "https://x.test/78", date: "2022-03-09" },
      { dimension: "x", kind: "post", claim: "@b posted on X: \"hi\"", quote: "hi", source_url: "https://x.com/b/1" },
      { dimension: "linkedin", kind: "mutuals", claim: "Mutual connections: A, B", source_url: "https://linkedin.com/in/b" },
      { dimension: "web", kind: "bio", claim: "YC partner", source_url: "https://yc.test" },
    ] });
    const [q, post, mut, bio] = evs;
    expect(q).toMatchObject({ section: "niche", label: "Looking for", claim: "“we are looking for teams that ship weekly”", depth: "Transcript: Ep 78", date: "Mar 9, 2022" });
    expect(q.use).toMatch(/Lead with this/);
    expect(post).toMatchObject({ section: "niche", label: "Recent post", claim: "@b posted on X: \"hi\"" }); // no duplicated quote
    expect(mut).toMatchObject({ section: "niche", label: "Mutual connections" });
    expect(bio).toMatchObject({ section: "persona", label: "Role" });
    expect(bio.use).toBeUndefined();
  });
});
