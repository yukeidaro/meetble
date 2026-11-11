import { describe, it, expect } from "vitest";
import { requestJson } from "../src/core/http.js";
import { HttpError } from "../src/core/errors.js";
import { FindingStore } from "../src/core/findings.js";
import { runStep } from "../src/core/step.js";
import { fakeFetch, makeCtx } from "./helpers.js";

describe("requestJson", () => {
  it("retries 429 then succeeds", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1 ? { status: 429, text: "slow down" } : { json: { ok: true } }));
    const r = await requestJson<{ ok: boolean }>({ service: "t", url: "https://x", headers: {}, body: {}, fetch });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
  });
  it("does not retry 401", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401, text: "bad key" }));
    await expect(requestJson({ service: "t", url: "https://x", headers: {}, body: {}, fetch })).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(1);
  });
});

describe("FindingStore", () => {
  it("rejects missing URLs and duplicates", () => {
    const s = new FindingStore();
    const base = { step: "step1" as const, tool: "t", kind: "bio", claim: "A", confidence: "high" as const };
    expect(s.save({ ...base, source_url: "" })).toBeNull();
    expect(s.save({ ...base, source_url: "javascript:alert(1)" })).toBeNull();
    expect(s.save({ ...base, source_url: "https://a.com" })?.id).toBe("f1");
    expect(s.save({ ...base, source_url: "https://a.com" })).toBeNull();
  });
});

describe("runStep", () => {
  it("turns a missing key into skipped, not a crash", async () => {
    const { ctx, events } = makeCtx(fakeFetch(() => ({})).fetch, {});
    const { requireKey } = await import("../src/core/http.js");
    const r = await runStep(ctx, "s", "label", async () => requireKey(ctx.env, "EXA_API_KEY"), () => "x");
    expect(r).toBeUndefined();
    expect(events.map((e) => e.status)).toEqual(["running", "skipped"]);
  });
});

describe("runStep skipped values", () => {
  it("shows {skipped:true} results as skipped", async () => {
    const { ctx, events } = makeCtx(fakeFetch(() => ({})).fetch);
    await runStep(ctx, "s", "l", async () => ({ skipped: true, reason: "no X handle" }), () => "x");
    expect(events.at(-1)).toMatchObject({ status: "skipped", note: "skipped: no X handle" });
  });
});

describe("requestJson cancel", () => {
  it("does not call fetch when already aborted", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const ac = new AbortController(); ac.abort();
    await expect(requestJson({ service: "t", url: "https://x", headers: {}, body: {}, fetch, signal: ac.signal })).rejects.toBeDefined();
    expect(calls.length).toBe(0);
  });
});
