import { describe, it, expect } from "vitest";
import { HttpError, MissingKeyError } from "../src/core/errors.js";
import { recentXMentions, summarizeRecentXMentions } from "../src/tools/recent_x_mentions.js";
import { fakeFetch, makeCtx } from "./helpers.js";

function xaiResponse(text: string, urls: string[] = []) {
  return {
    object: "response",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: urls.map((url) => ({ type: "url_citation", url, start_index: 0, end_index: 1, title: "1" })) }] }],
  };
}

const target = { name: "Boris Jabes", company: "Y Combinator", role: "Partner", x_handle: "BorisJabes" };

describe("recent_x_mentions", () => {
  it("queries 7 days by name and handle, no handle restriction, and saves mentions", async () => {
    const posts = {
      posts: [
        { text: "Great office hours with Boris Jabes today", date: "2026-11-10", url: "https://x.com/founder1/status/10", author: "founder1" },
        { text: "Shipping season.", date: "2026-11-11", url: "https://twitter.com/BorisJabes/status/11" },
        { text: "no url", date: "2026-11-10" },
        { text: "old", date: "2026-10-01", url: "https://x.com/someone/status/12" },
        { text: "link to profile, not a post", url: "https://x.com/BorisJabes" },
      ],
    };
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse("```json\n" + JSON.stringify(posts) + "\n```", ["https://x.com/founder1/status/10"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await recentXMentions({ target }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.model).toBe("grok-4.7");
    expect(calls[0]!.body.tools).toEqual([{ type: "x_search", from_date: "2026-11-04" }]);
    const prompt: string = calls[0]!.body.input[0].content;
    expect(prompt).toContain('"Boris Jabes"');
    expect(prompt).toContain("@BorisJabes");
    expect(prompt).toContain("2026-11-04");
    expect(r.widened).toBe(false);
    expect(r.windowDays).toBe(7);
    expect(r.mentions).toEqual([
      { text: "Great office hours with Boris Jabes today", date: "2026-11-10", url: "https://x.com/founder1/status/10", author: "founder1", byTarget: false, cited: true },
      { text: "Shipping season.", date: "2026-11-11", url: "https://x.com/BorisJabes/status/11", author: "BorisJabes", byTarget: true, cited: false },
    ]);
    const f = ctx.findings.all();
    expect(f.map((x) => [x.kind, x.step, x.tool, x.source_url, x.confidence])).toEqual([
      ["mention", "step2", "recent_x_mentions", "https://x.com/founder1/status/10", "high"],
      ["mention", "step2", "recent_x_mentions", "https://x.com/BorisJabes/status/11", "medium"],
    ]);
    expect(f[0]!.claim).toBe('@founder1 posted about Boris Jabes on X on 2026-11-10: "Great office hours with Boris Jabes today"');
    expect(f[1]!.claim).toBe('Boris Jabes posted on X on 2026-11-11: "Shipping season."');
    expect(summarizeRecentXMentions(r)).toBe("2 posts in 7 days");
  });

  it("widens 7 -> 30 days when nothing is found", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1
      ? { json: xaiResponse('{"posts":[]}') }
      : { json: xaiResponse('{"posts":[{"text":"Boris on dev tools","date":"2026-10-20","url":"https://x.com/a/status/1"},{"text":"x","date":"2026-10-30","url":"https://x.com/b/status/2"},{"text":"y","url":"https://x.com/c/status/3"}]}') }));
    const { ctx } = makeCtx(fetch);
    const r = await recentXMentions({ target }, ctx);
    expect(calls.map((c) => c.body.tools[0].from_date)).toEqual(["2026-11-04", "2026-10-12"]);
    expect(calls[1]!.body.input[0].content).toContain("2026-10-12");
    expect(r.widened).toBe(true);
    expect(r.windowDays).toBe(30);
    expect(r.fromDate).toBe("2026-10-12");
    expect(r.mentions).toHaveLength(3);
    expect(ctx.findings.all().every((f) => f.data?.widened === true && f.data?.window_days === 30)).toBe(true);
    expect(summarizeRecentXMentions(r)).toBe("nothing in 7 days, widened to 30: 3 posts");
  });

  it("reports nothing in both windows; malformed JSON is not a crash", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse("I could not find posts {oops") }));
    const { ctx } = makeCtx(fetch);
    const r = await recentXMentions({ target }, ctx);
    expect(calls).toHaveLength(2);
    expect(r.mentions).toEqual([]);
    expect(r.rawText).toBe("I could not find posts {oops");
    expect(ctx.findings.all()).toEqual([]);
    expect(summarizeRecentXMentions(r)).toBe("nothing in 7 or 30 days");
  });

  it("accepts a bare JSON array and works without a handle", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse('[{"text":"Boris Jabes joins YC","date":"2026-11-05","url":"https://x.com/ycombinator/status/7"}]') }));
    const { ctx } = makeCtx(fetch);
    const r = await recentXMentions({ target: { name: "Boris Jabes" } }, ctx);
    expect(calls[0]!.body.input[0].content).not.toContain("@");
    expect(r.mentions[0]).toMatchObject({ author: "ycombinator", byTarget: false });
  });

  it("missing key and 401 surface correctly", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401, text: "bad key" }));
    await expect(recentXMentions({ target }, makeCtx(fetch, {}).ctx)).rejects.toBeInstanceOf(MissingKeyError);
    expect(calls).toHaveLength(0);
    await expect(recentXMentions({ target }, makeCtx(fetch).ctx)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });
});
