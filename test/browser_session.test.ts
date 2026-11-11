import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCheck, lumaMyEvents, summarizeLoginCheck, summarizeLumaMyEvents } from "../src/tools/browser_session.js";
import { fakeFetch, makeCtx } from "./helpers.js";

const cwd = mkdtempSync(join(tmpdir(), "meetble-"));
writeFileSync(join(cwd, "browser_tools.py"), "");
const env = { BROWSER_PYTHON: "python" } as NodeJS.ProcessEnv;
const { ctx } = makeCtx(fakeFetch(() => ({ json: {} })).fetch);
const runner = (stdout: string, code = 0) => {
  const calls: string[][] = [];
  return { calls, run: async (_c: string, args: string[]) => { calls.push(args); return { code, stdout, stderr: "" }; } };
};

describe("loginCheck", () => {
  it("lists signed-out sites and flags a Luma account mismatch", async () => {
    const { run, calls } = runner('browser-use log\n{"luma":{"logged_in":true,"account":"other@example.com"},"linkedin":{"logged_in":true,"account":"Yu"},"x":{"logged_in":false,"account":""}}');
    const r = await loginCheck({}, ctx, { run, cwd, env: { ...env, LUMA_ACCOUNT: "me@example.com" } });
    expect(calls[0]!.slice(-1)).toEqual(["login-check"]);
    expect(r.signed_out).toEqual(["x", "instagram"]); // instagram missing from output = not signed in
    expect(r.account_mismatch).toBe("Luma is signed in as other@example.com, expected me@example.com");
    expect(summarizeLoginCheck(r)).toBe("signed in: luma, linkedin; not signed in: x, instagram; Luma is signed in as other@example.com, expected me@example.com");
  });

  it("accepts the expected account and skips without a venv", async () => {
    const { run } = runner('{"luma":{"logged_in":true,"account":"Me@Example.com"},"linkedin":{"logged_in":true,"account":"Yu"},"x":{"logged_in":true,"account":"@yu"},"instagram":{"logged_in":true,"account":"yu"}}');
    const r = await loginCheck({}, ctx, { run, cwd, env: { ...env, LUMA_ACCOUNT: "me@example.com" } });
    expect(r.signed_out).toEqual([]);
    expect(r.account_mismatch).toBeUndefined();
    expect(await loginCheck({}, ctx, { cwd: mkdtempSync(join(tmpdir(), "none-")), env: {} })).toMatchObject({ skipped: true });
  });

  it("throws on a browser error so the step shows as failed", async () => {
    const { run } = runner('{"error":"no result"}');
    await expect(loginCheck({}, ctx, { run, cwd, env })).rejects.toThrow("browser: no result");
  });
});

describe("lumaMyEvents", () => {
  it("keeps only real Luma event URLs, deduped", async () => {
    const { run } = runner(JSON.stringify({ events: [
      { title: "c0mpiled-18", url: "https://luma.com/compiled-poy7", date_time: "Nov 11, 6 PM", status: "Going" },
      { title: "dup", url: "https://luma.com/compiled-poy7" },
      { title: "home", url: "https://luma.com/home" },
      { title: "relative", url: "/abc" },
      { title: "old domain", url: "https://lu.ma/xyz" },
    ] }));
    const r = await lumaMyEvents({}, ctx, { run, cwd, env });
    expect(r.events.map((e) => e.url)).toEqual(["https://luma.com/compiled-poy7", "https://lu.ma/xyz"]);
    expect(summarizeLumaMyEvents(r)).toBe("2 upcoming events you're going to");
  });
});
