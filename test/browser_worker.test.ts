import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BrowserWorker, resetBrowserWorker } from "../src/tools/browser_worker.js";
import { callBrowser } from "../src/tools/browser_session.js";

const fake = join(import.meta.dirname, "fixtures", "fake_worker.cjs");
const cwd = mkdtempSync(join(tmpdir(), "meetble-w-"));
copyFileSync(fake, join(cwd, "browser_tools.py")); // run with node, so the .py name doesn't matter
const env = { ...process.env, BROWSER_PYTHON: process.execPath } as NodeJS.ProcessEnv;

beforeEach(() => resetBrowserWorker());

describe("browser worker", () => {
  it("runs every task over one connection to one worker process", async () => {
    const w = new BrowserWorker({ python: process.execPath, script: fake, cwd, env });
    const a = await w.call("cookie-check", []);
    const [b, c] = await Promise.all([w.call("luma-my-events", []), w.call("linkedin-profile", ["Boris Jabes"])]);
    expect(a.pid).toBe(b.pid);
    expect(c).toMatchObject({ cmd: "linkedin-profile", args: ["Boris Jabes"], pid: a.pid });
    expect((await w.call("stats", [])).conns).toBe(1);
    w.close();
  });

  it("cancels a task in the worker when the step's budget runs out", async () => {
    const w = new BrowserWorker({ python: process.execPath, script: fake, cwd, env });
    await w.start();
    const ac = new AbortController();
    const p = w.call("slow", [], { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("over budget")), 30);
    await expect(p).rejects.toThrow("over budget");
    await expect(w.call("stats", [])).resolves.toMatchObject({ cancelled: [1] });
    const late = new AbortController(); late.abort(new Error("already over"));
    await expect(w.call("cookie-check", [], { signal: late.signal })).rejects.toThrow("already over");
    w.close();
  });

  it("research uses the worker by default and the server's worker when one is passed in", async () => {
    const r1 = await callBrowser("cookie-check", { cwd, env });
    const r2 = await callBrowser("luma-my-events", { cwd, env });
    expect("json" in r1 && "json" in r2 && r1.json.pid === r2.json.pid).toBe(true);
    const own = new BrowserWorker({ python: process.execPath, script: fake, cwd, env: { ...env, MEETBLE_WORKER_TOKEN: "x" } });
    await own.start();
    // Reach the same kind of worker through MEETBLE_BROWSER_WORKER, as server.mjs passes it.
    const port = await new Promise<number>((resolve) => {
      const p = spawn(process.execPath, [fake, "serve"], { env: { ...env, MEETBLE_WORKER_TOKEN: "srv" }, stdio: ["pipe", "pipe", "ignore"] });
      p.stdout!.on("data", (d) => { const m = /"listening":(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
      p.unref();
    });
    resetBrowserWorker();
    const r3 = await callBrowser("cookie-check", { cwd, env: { ...env, MEETBLE_BROWSER_WORKER: `127.0.0.1:${port}`, MEETBLE_WORKER_TOKEN: "srv" } });
    expect("json" in r3 && r3.json.cmd).toBe("cookie-check");
    own.close();
  });

  it("falls back to one process per task when the worker can't start (an older browser_tools.py)", async () => {
    const r = await callBrowser("luma-my-events", { cwd, env: { ...env, FAKE_NO_SERVE: "1" } });
    expect("json" in r && r.json).toEqual({ oneshot: "luma-my-events", args: [] });
  });

  it("MEETBLE_BROWSER_WORKER=0 turns it off", async () => {
    const r = await callBrowser("cookie-check", { cwd, env: { ...env, MEETBLE_BROWSER_WORKER: "0" } });
    expect("json" in r && r.json.oneshot).toBe("cookie-check");
  });
});
