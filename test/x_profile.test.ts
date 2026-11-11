import { describe, it, expect } from "vitest";
import { HttpError, MissingKeyError } from "../src/core/errors.js";
import { runStep } from "../src/core/step.js";
import { summarizeXProfile, xProfile } from "../src/tools/x_profile.js";
import { fakeFetch, makeCtx } from "./helpers.js";

function xaiResponse(text: string, urls: string[] = []) {
  return {
    object: "response",
    output: [
      { type: "custom_tool_call", name: "x_semantic_search" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: urls.map((url) => ({ type: "url_citation", url, start_index: 0, end_index: 1, title: "1" })) }] },
    ],
  };
}

const target = { name: "Boris Jabes", company: "Y Combinator", role: "Partner", x_handle: "@BorisJabes " };

const goodJson = {
  posts: [
    { text: "Demo day is next week. Founders: tell the story.", date: "2026-11-09", url: "https://x.com/BorisJabes/status/111" },
    { text: "Dup of the first post", date: "2026-11-09", url: "https://twitter.com/borisjabes/status/111?s=20" },
    { text: "Hallucinated, no url", date: "2026-11-08" },
    { text: "Bad url", date: "2026-11-08", url: "https://x.com/BorisJabes" },
    { text: "Somebody else's post", date: "2026-11-07", url: "https://x.com/paulg/status/222" },
    { text: "Too old", date: "2026-08-01", url: "https://x.com/BorisJabes/status/333" },
    { text: "Future date", date: "2026-12-01", url: "https://x.com/BorisJabes/status/334" },
    { text: "Uncited but well-formed, ISO time", date: "2026-10-01T15:00:00Z", url: "https://x.com/BorisJabes/status/444" },
    { text: "", date: "2026-10-01", url: "https://x.com/BorisJabes/status/555" },
  ],
  inner_circle: [
    { handle: "@garrytan", count: 9 },
    { handle: "dalton", count: "4" },
    { handle: "GarryTan", count: 2 },
    { handle: "BorisJabes", count: 50 },
    { handle: "bad handle!", count: 3 },
    { handle: "zero", count: 0 },
  ],
  topics: ["AI agents", "developer tools", "AI agents", 7],
  posting_hours_utc: [16, 17, 25, -1, 3.5, "18"],
};

describe("x_profile", () => {
  it("skips without calling the API when there is no handle", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const { ctx } = makeCtx(fetch);
    const r = await xProfile({ target: { name: "Boris Jabes" } }, ctx);
    expect(r).toEqual({ skipped: true, reason: "no X handle for target" });
    expect(calls).toHaveLength(0);
    expect(summarizeXProfile(r)).toBe("skipped: no X handle for target");
    const r2 = await xProfile({ target: { name: "B", x_handle: " @ " } }, ctx);
    expect(r2.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("sends handle + 60-day UTC window, no to_date", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse("{}") }));
    const { ctx } = makeCtx(fetch);
    await xProfile({ target }, ctx);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body.model).toBe("grok-4.7");
    expect(body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["BorisJabes"], from_date: "2026-09-12" }]);
    expect(body.input[0].content).toContain("@BorisJabes");
    expect(body.input[0].content).toContain("2026-09-12");
    expect(body.input[0].content).toContain("STRICT JSON");
  });

  it("parses fenced JSON, drops invented/malformed/foreign/out-of-window URLs, saves findings", async () => {
    const text = "Here is the analysis:\n```json\n" + JSON.stringify(goodJson, null, 2) + "\n```";
    const { fetch } = fakeFetch(() => ({ json: xaiResponse(text, ["https://x.com/BorisJabes/status/111"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await xProfile({ target }, ctx);
    if (r.skipped) throw new Error("unexpected skip");
    expect(r.handle).toBe("BorisJabes");
    expect(r.posts).toEqual([
      { text: "Demo day is next week. Founders: tell the story.", date: "2026-11-09", url: "https://x.com/BorisJabes/status/111", cited: true },
      { text: "Uncited but well-formed, ISO time", date: "2026-10-01", url: "https://x.com/BorisJabes/status/444", cited: false },
    ]);
    expect(r.innerCircle).toEqual([{ handle: "garrytan", count: 11 }, { handle: "dalton", count: 4 }]);
    expect(r.topics).toEqual(["AI agents", "developer tools"]);
    expect(r.postingHoursUtc).toEqual([16, 17]);
    expect(r.rawText).toBeUndefined();

    const f = ctx.findings.all();
    const posts = f.filter((x) => x.kind === "post");
    expect(posts.map((p) => p.source_url)).toEqual(["https://x.com/BorisJabes/status/111", "https://x.com/BorisJabes/status/444"]);
    expect(posts[0]).toMatchObject({ step: "step1", tool: "x_profile", confidence: "high", date: "2026-11-09", quote: "Demo day is next week. Founders: tell the story." });
    expect(posts[1]!.confidence).toBe("medium");
    const ic = f.filter((x) => x.kind === "inner_circle");
    expect(ic).toHaveLength(2);
    expect(ic.every((x) => x.source_url === "https://x.com/BorisJabes")).toBe(true);
    expect(ic[0]!.claim).toBe("@BorisJabes replied to @garrytan 11 times in the last 60 days");
    expect(summarizeXProfile(r)).toBe("2 posts, replies most to @garrytan, topics: AI agents, developer tools");
  });

  it("returns raw text and saves nothing on malformed JSON", async () => {
    const { fetch } = fakeFetch(() => ({ json: xaiResponse('{"posts":[{"text":"a","url":"https://x.com/BorisJabes/status/1"') }));
    const { ctx } = makeCtx(fetch);
    const r = await xProfile({ target }, ctx);
    if (r.skipped) throw new Error("unexpected skip");
    expect(r.posts).toEqual([]);
    expect(r.rawText).toContain('"posts"');
    expect(ctx.findings.all()).toEqual([]);
    expect(summarizeXProfile(r)).toBe("Grok answer was not valid JSON; no posts saved");
  });

  it("handles an empty result and a response with no message", async () => {
    const { fetch } = fakeFetch(() => ({ json: { object: "response", output: [] } }));
    const { ctx } = makeCtx(fetch);
    const r = await xProfile({ target }, ctx);
    if (r.skipped) throw new Error("unexpected skip");
    expect(r.posts).toEqual([]);
    const { fetch: f2 } = fakeFetch(() => ({ json: xaiResponse('{"posts":[],"inner_circle":[],"topics":[],"posting_hours_utc":[]}') }));
    const r2 = await xProfile({ target }, makeCtx(f2).ctx);
    expect(summarizeXProfile(r2)).toBe("0 posts");
  });

  it("missing XAI key -> MissingKeyError -> runStep skipped", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const { ctx, events } = makeCtx(fetch, {});
    await expect(xProfile({ target }, ctx)).rejects.toBeInstanceOf(MissingKeyError);
    await runStep(ctx, "step1.x_profile", "X", () => xProfile({ target }, ctx), summarizeXProfile);
    expect(events.at(-1)!.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("HTTP 401 surfaces as HttpError without retry", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401, text: "unauthorized" }));
    const { ctx } = makeCtx(fetch);
    await expect(xProfile({ target }, ctx)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });
});
