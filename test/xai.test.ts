import { describe, it, expect, vi } from "vitest";
import { HttpError, MissingKeyError, TimeoutError } from "../src/core/errors.js";
import {
  XAI_MODEL, XAI_URL, isYmd, normalizeHandle, parseJsonLoose, parseResponsesOutput, parseStatusUrl, toYmd, xaiXSearch, ymdDaysAgo,
} from "../src/tools/xai.js";
import { fakeFetch, makeCtx } from "./helpers.js";

function xaiResponse(text: string, urls: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "grok-4.7",
    output: [
      { type: "custom_tool_call", name: "x_keyword_search", input: "{}" },
      { type: "reasoning", summary: [] },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text,
          logprobs: [],
          annotations: urls.map((url, i) => ({ type: "url_citation", url, start_index: 0, end_index: 1, title: String(i + 1) })),
        }],
      },
    ],
    ...extra,
  };
}

describe("xai helpers", () => {
  it("normalizes handles", () => {
    expect(normalizeHandle(" @BorisJabes ")).toBe("BorisJabes");
    expect(normalizeHandle("https://x.com/BorisJabes/")).toBe("BorisJabes");
    expect(normalizeHandle("twitter.com/borisjabes?s=1")).toBe("borisjabes");
    expect(normalizeHandle(undefined)).toBe("");
  });
  it("validates and computes UTC dates", () => {
    expect(isYmd("2026-11-11")).toBe(true);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("2026-11-11T00:00:00Z")).toBe(false);
    const now = new Date("2026-11-11T12:00:00Z");
    expect(ymdDaysAgo(now, 7)).toBe("2026-11-04");
    expect(ymdDaysAgo(now, 60)).toBe("2026-09-12");
    // just after midnight UTC must not slip a day (local-time bug guard)
    expect(ymdDaysAgo(new Date("2026-03-01T00:30:00Z"), 1)).toBe("2026-02-28");
    expect(toYmd("2026-11-10T23:59:00Z")).toBe("2026-11-10");
    expect(toYmd("Nov 10")).toBeUndefined();
  });
  it("parses status URLs strictly", () => {
    expect(parseStatusUrl("https://twitter.com/BorisJabes/status/123?s=20")).toEqual({ url: "https://x.com/BorisJabes/status/123", user: "BorisJabes", id: "123" });
    expect(parseStatusUrl("https://x.com/i/web/status/9")?.url).toBe("https://x.com/i/status/9");
    expect(parseStatusUrl("https://x.com/BorisJabes")).toBeNull();
    expect(parseStatusUrl("https://evil.com/x.com/a/status/1")).toBeNull();
    expect(parseStatusUrl("https://x.com.evil.com/a/status/1")).toBeNull();
    expect(parseStatusUrl(42)).toBeNull();
  });
  it("finds JSON in fenced, prefixed and broken text", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go:\n```json\n{"a":[1,2]}\n```\nthanks')).toEqual({ a: [1, 2] });
    expect(parseJsonLoose('Sure! {"a":"has } brace"} trailing')).toEqual({ a: "has } brace" });
    expect(parseJsonLoose('[1,2] then {"b":2}')).toEqual([1, 2]);
    expect(parseJsonLoose('{"a":1,')).toBeNull();
    expect(parseJsonLoose("no json here")).toBeNull();
    expect(parseJsonLoose("42")).toBeNull();
  });
  it("parses Responses output text and citations, ignoring non-message items", () => {
    const r = parseResponsesOutput(xaiResponse("hi", ["https://x.com/a/status/1"], { citations: ["https://x.com/b/status/2"] }));
    expect(r.text).toBe("hi");
    expect(r.urls).toEqual(["https://x.com/a/status/1", "https://x.com/b/status/2"]);
    expect(parseResponsesOutput(null)).toEqual({ text: "", urls: [] });
    expect(parseResponsesOutput({ output: "nope" })).toEqual({ text: "", urls: [] });
  });
});

describe("xaiXSearch", () => {
  it("sends the exact documented request", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse('{"ok":true}', ["https://twitter.com/BorisJabes/status/5", "https://ycombinator.com/x", "https://x.com/BorisJabes/status/5"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await xaiXSearch({ prompt: "p", handles: ["@BorisJabes", "borisjabes", " pg "], fromDate: "2026-09-12", toDate: "2026-11-12" }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(XAI_URL);
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/responses");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(calls[0]!.body).toEqual({
      model: XAI_MODEL,
      input: [{ role: "user", content: "p" }],
      tools: [{ type: "x_search", allowed_x_handles: ["BorisJabes", "pg"], from_date: "2026-09-12", to_date: "2026-11-12" }],
      include: ["no_inline_citations"],
    });
    expect(XAI_MODEL).toBe("grok-4.7");
    expect(r.citations).toEqual(["https://x.com/BorisJabes/status/5"]);
    expect(r.json).toEqual({ ok: true });
  });
  it("omits optional fields and sends excluded handles", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse("plain") }));
    const { ctx } = makeCtx(fetch);
    const r = await xaiXSearch({ prompt: "p", excludeHandles: ["@spam"], handles: [] }, ctx);
    expect(calls[0]!.body.tools).toEqual([{ type: "x_search", excluded_x_handles: ["spam"] }]);
    expect(r).toEqual({ text: "plain", citations: [], json: null });
  });
  it.each([
    [{ handles: Array.from({ length: 21 }, (_, i) => `h${i}`) }, /at most 20/],
    [{ handles: ["a"], excludeHandles: ["b"] }, /cannot both be set/],
    [{ handles: ["not a handle!"] }, /invalid X handle/],
    [{ handles: ["waytoolonghandle_123"] }, /invalid X handle/],
    [{ fromDate: "2026-9-1" }, /fromDate must be YYYY-MM-DD/],
    [{ toDate: "2026-11-11T00:00:00Z" }, /toDate must be YYYY-MM-DD/],
    [{ fromDate: "2026-11-11", toDate: "2026-11-11" }, /must be before toDate/],
    [{ prompt: "  " }, /prompt is required/],
  ])("rejects invalid input %j before calling the API", async (bad, msg) => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse("x") }));
    const { ctx } = makeCtx(fetch);
    await expect(xaiXSearch({ prompt: "p", ...bad } as any, ctx)).rejects.toThrow(msg);
    expect(calls).toHaveLength(0);
  });
  it("accepts exactly 20 handles (deduped case-insensitively)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse("x") }));
    const { ctx } = makeCtx(fetch);
    const handles = [...Array.from({ length: 20 }, (_, i) => `h${i}`), "H0", "@h1"];
    await xaiXSearch({ prompt: "p", handles }, ctx);
    expect(calls[0]!.body.tools[0].allowed_x_handles).toHaveLength(20);
  });
  it("turns off inline citations so the model's STRICT JSON stays parseable", async () => {
    // Documented REST behavior: inline [[N]](url) markers are inserted into output_text by default
    // (https://docs.x.ai/developers/tools/citations); they land inside our JSON and break it.
    const json = '{"posts":[{"text":"Shipping","url":"https://x.com/a/status/1"}]}';
    const { fetch, calls } = fakeFetch((_u, body) => {
      const inline = !(Array.isArray(body.include) && body.include.includes("no_inline_citations"));
      const text = inline ? json.replace('"Shipping"', '"Shipping" [[1]](https://x.com/i/status/1)') : json;
      return { json: xaiResponse(text, ["https://x.com/i/status/1"]) };
    });
    const { ctx } = makeCtx(fetch);
    const r = await xaiXSearch({ prompt: "p" }, ctx);
    expect(calls[0]!.body.include).toEqual(["no_inline_citations"]);
    expect(r.json).toEqual(JSON.parse(json));
    expect(r.citations).toEqual(["https://x.com/i/status/1"]);
  });
  it("throws MissingKeyError without XAI_API_KEY and makes no call", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const { ctx } = makeCtx(fetch, { XAI_API_KEY: "  " });
    await expect(xaiXSearch({ prompt: "p" }, ctx)).rejects.toBeInstanceOf(MissingKeyError);
    expect(calls).toHaveLength(0);
  });
  it("surfaces 401 as HttpError without retry", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401, text: '{"error":"invalid api key"}' }));
    const { ctx } = makeCtx(fetch);
    const err = await xaiXSearch({ prompt: "p" }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.service).toBe("xai");
    expect(calls).toHaveLength(1);
  });
});

describe("xaiXSearch cost guard", () => {
  it("does not re-send a billed agentic search after it timed out", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetch = (_u: string, init?: RequestInit) => {
        calls++;
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      };
      const { ctx } = makeCtx(fetch);
      const p = xaiXSearch({ prompt: "p" }, ctx).catch((e) => e);
      await vi.advanceTimersByTimeAsync(600_000);
      const err = await p;
      expect(err).toBeInstanceOf(TimeoutError);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
