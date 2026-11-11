import { describe, it, expect, vi } from "vitest";
import { HttpError, MissingKeyError, TimeoutError } from "../src/core/errors.js";
import { runStep } from "../src/core/step.js";
import { META_MODEL, META_RESPONSES_URL, instagramPublic, summarizeInstagramPublic } from "../src/tools/instagram_public.js";
import { fakeFetch, makeCtx } from "./helpers.js";

function metaResponse(text: string, urls: string[] = []) {
  return {
    id: "resp_123", object: "response", status: "completed", model: "muse-spark-1.1",
    output: [
      { type: "web_search_call", status: "completed" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: urls.map((url) => ({ type: "url_citation", url, title: "t", start_index: 0, end_index: 1 })) }] },
    ],
  };
}

const target = { name: "Boris Jabes", company: "Y Combinator", role: "Partner" };

describe("instagram_public", () => {
  it("throws MissingKeyError without MODEL_API_KEY (runStep -> skipped) and makes no call", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const { ctx, events } = makeCtx(fetch, { XAI_API_KEY: "k" });
    await expect(instagramPublic({ target }, ctx)).rejects.toBeInstanceOf(MissingKeyError);
    await runStep(ctx, "step1.instagram", "IG", () => instagramPublic({ target }, ctx), summarizeInstagramPublic);
    expect(events.map((e) => e.status)).toEqual(["running", "skipped"]);
    expect(calls).toHaveLength(0);
  });

  it("sends the documented request with a professional-only prompt", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: metaResponse('{"account":null,"topics":[]}') }));
    const { ctx } = makeCtx(fetch);
    const r = await instagramPublic({ target: { ...target, instagram_handle: "@borisjabes" } }, ctx);
    expect(calls[0]!.url).toBe(META_RESPONSES_URL);
    expect(META_RESPONSES_URL).toBe("https://api.meta.ai/v1/responses");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(calls[0]!.body.model).toBe(META_MODEL);
    expect(calls[0]!.body.tools).toEqual([{ type: "web_search" }]);
    const prompt: string = calls[0]!.body.input;
    expect(prompt).toContain("PUBLIC, PROFESSIONAL");
    expect(prompt).toContain("@borisjabes");
    expect(prompt).toMatch(/Do NOT report family members/);
    expect(r).toEqual({ topics: [], citations: [] });
    expect(summarizeInstagramPublic(r)).toBe("no public Instagram found");
  });

  it("saves account + topics only when their URLs were cited", async () => {
    const json = {
      account: { handle: "@borisjabes", url: "https://instagram.com/borisjabes", bio: "Partner @ycombinator" },
      topics: [
        { topic: "YC Demo Day", source_url: "https://www.instagram.com/p/ABC123/" },
        { topic: "Invented topic", source_url: "https://www.instagram.com/p/NOTCITED/" },
        { topic: "No source" },
        { topic: "yc demo day", source_url: "https://www.instagram.com/p/ABC123/" },
      ],
    };
    const { fetch } = fakeFetch(() => ({ json: metaResponse("```json\n" + JSON.stringify(json) + "\n```", ["https://www.instagram.com/borisjabes/", "https://www.instagram.com/p/ABC123/"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await instagramPublic({ target }, ctx);
    expect(r.account).toEqual({ handle: "borisjabes", url: "https://www.instagram.com/borisjabes/", bio: "Partner @ycombinator" });
    expect(r.topics).toEqual([{ topic: "YC Demo Day", url: "https://www.instagram.com/p/ABC123/" }]);
    const f = ctx.findings.all();
    expect(f.map((x) => [x.kind, x.tool, x.step, x.source_url])).toEqual([
      ["instagram", "instagram_public", "step1", "https://www.instagram.com/borisjabes/"],
      ["instagram", "instagram_public", "step1", "https://www.instagram.com/p/ABC123/"],
    ]);
    expect(summarizeInstagramPublic(r)).toBe("@borisjabes, 1 topic");
  });

  it("drops an account whose profile URL was not cited", async () => {
    const { fetch } = fakeFetch(() => ({ json: metaResponse('{"account":{"handle":"borisjabes","url":"https://instagram.com/borisjabes"},"topics":[]}', ["https://www.instagram.com/someoneelse/"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await instagramPublic({ target }, ctx);
    expect(r.account).toBeUndefined();
    expect(ctx.findings.all()).toEqual([]);
  });

  it("malformed JSON returns raw text, saves nothing", async () => {
    const { fetch } = fakeFetch(() => ({ json: metaResponse("He has an account {not json", ["https://www.instagram.com/borisjabes/"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await instagramPublic({ target }, ctx);
    expect(r.rawText).toBe("He has an account {not json");
    expect(ctx.findings.all()).toEqual([]);
    expect(summarizeInstagramPublic(r)).toBe("answer was not valid JSON; nothing saved");
  });

  it("HTTP 401 surfaces as HttpError without retry", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401, text: "bad key" }));
    const err = await instagramPublic({ target }, makeCtx(fetch).ctx).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.service).toBe("meta");
    expect(calls).toHaveLength(1);
  });
});

describe("instagram_public cost guard", () => {
  it("does not re-send a billed web-search call after it timed out", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetch = (_u: string, init?: RequestInit) => {
        calls++;
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      };
      const { ctx } = makeCtx(fetch);
      const p = instagramPublic({ target: { name: "Boris Jabes" } }, ctx).catch((e) => e);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await p).toBeInstanceOf(TimeoutError);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
