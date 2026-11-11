import { describe, it, expect } from "vitest";
import { findXHandle, summarizeFindXHandle } from "../src/tools/find_x_handle.js";
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

const target = { name: "Boris Jabes", role: "Visiting Partner", company: "Y Combinator" };

describe("findXHandle", () => {
  it("accepts a handle only when Grok cites a post by it (case-insensitive)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: xaiResponse('{"handle":"@BorisJabes"}', ["https://x.com/borisjabes/status/2117769609289863571"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await findXHandle({ target }, ctx);
    expect(r.handle).toBe("BorisJabes");
    expect(calls[0]!.body.tools[0].type).toBe("x_search");
    expect(ctx.findings.all()[0]).toMatchObject({ tool: "find_x_handle", source_url: "https://x.com/borisjabes/status/2117769609289863571" });
    expect(summarizeFindXHandle(r)).toBe("@BorisJabes");
  });
  it("confirms an uncited suggestion with a second, account-limited search (live-run regression)", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1
      ? { json: xaiResponse('{"handle":"borisjabes"}', ["https://x.com/someoneelse/status/1"]) }
      : { json: xaiResponse('{"display_name":"Boris Jabes","bio":"Partner @ycombinator"}', ["https://x.com/borisjabes/status/2117769609289863571"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await findXHandle({ target }, ctx);
    expect(r.handle).toBe("borisjabes");
    expect(calls[1]!.body.tools[0].allowed_x_handles).toEqual(["borisjabes"]);
  });
  it("accepts x.com/i/status citations from the account-limited search (live-run regression)", async () => {
    let n = 0;
    const { fetch } = fakeFetch(() => (++n === 1
      ? { json: xaiResponse('{"handle":"borisjabes"}', ["https://x.com/i/status/9"]) }
      : { json: xaiResponse('{"display_name":"Boris Jabes","bio":"Visiting partner @ycombinator"}', ["https://x.com/i/status/2117769609289863571"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await findXHandle({ target }, ctx);
    expect(r).toMatchObject({ handle: "borisjabes", evidence_url: "https://x.com/borisjabes/status/2117769609289863571" });
  });
  it("rejects when the second search shows a different person", async () => {
    let n = 0;
    const { fetch } = fakeFetch(() => (++n === 1
      ? { json: xaiResponse('{"handle":"borisjabes"}', []) }
      : { json: xaiResponse('{"display_name":"Boris J. Fan Club","bio":"memes"}', ["https://x.com/borisjabes/status/1"]) }));
    const { ctx } = makeCtx(fetch);
    expect((await findXHandle({ target }, ctx)).handle).toBeUndefined();
  });
  it("rejects a suggested handle with no post by it", async () => {
    const { fetch } = fakeFetch(() => ({ json: xaiResponse('{"handle":"borisjabes"}', ["https://x.com/someoneelse/status/1"]) }));
    const { ctx } = makeCtx(fetch);
    const r = await findXHandle({ target }, ctx);
    expect(r.handle).toBeUndefined();
    expect(ctx.findings.all()).toHaveLength(0);
  });
  it("handles null and junk answers", async () => {
    for (const text of ['{"handle":null}', "no idea", '{"handle":"not a handle!"}']) {
      const { fetch } = fakeFetch(() => ({ json: xaiResponse(text, []) }));
      const { ctx } = makeCtx(fetch);
      expect((await findXHandle({ target }, ctx)).handle).toBeUndefined();
    }
  });
  it("skips when the handle is already known (no API call)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const { ctx } = makeCtx(fetch);
    expect((await findXHandle({ target: { ...target, x_handle: "b" } }, ctx)).skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
