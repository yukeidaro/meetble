// One long-lived browser worker (browser_tools.py serve) instead of a new Python process per browser task.
//
// Why: Chrome asks "Allow?" for every new remote-debugging connection, and each one-shot
// `python browser_tools.py <cmd>` opened its own (sign-in check, your Luma events, LinkedIn: three clicks a run,
// plus ~3 s of Python start-up each). The worker keeps its connection open, so you click Allow once per worker.
//
// Where the worker lives:
//  - server.mjs starts one and passes MEETBLE_BROWSER_WORKER=127.0.0.1:<port> and MEETBLE_WORKER_TOKEN to each
//    research run, so the Allow click happens once per server, not once per run.
//  - Run on its own (node dist/cli.js), research starts its own worker and stops it on exit.
// MEETBLE_BROWSER_WORKER=0 turns it off (back to one process per task). If the worker can't start, callers fall
// back to one process per task too.
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export class BrowserWorker {
  private sock?: Socket;
  private ready?: Promise<void>;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private child?: ChildProcess;

  constructor(private readonly addr: { host: string; port: number; token: string } | { python: string; script: string; cwd: string; env: NodeJS.ProcessEnv }) {}

  /** Connects (starting the worker first if this process owns it). Rejects if it can't within startMs. */
  start(startMs = 30_000): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let host = "127.0.0.1", port: number, token: string;
      if ("port" in this.addr) ({ host, port, token } = this.addr);
      else ({ port, token } = await this.spawnWorker(startMs));
      this.token = token;
      await new Promise<void>((resolve, reject) => {
        const s = connect({ host, port }, () => resolve());
        s.setEncoding("utf8");
        s.on("data", (d: string) => this.onData(d));
        s.on("error", (e) => { reject(e); this.fail(e); });
        s.on("close", () => this.fail(new Error("browser worker closed the connection")));
        s.unref();
        this.sock = s;
      });
    })();
    this.ready.catch(() => { this.ready = undefined; });
    return this.ready;
  }

  private token = "";

  private spawnWorker(startMs: number): Promise<{ port: number; token: string }> {
    const a = this.addr as { python: string; script: string; cwd: string; env: NodeJS.ProcessEnv };
    const token = randomBytes(18).toString("hex");
    return new Promise((resolve, reject) => {
      const p = spawn(a.python, [a.script, "serve", "--exit-on-stdin-eof"], { cwd: a.cwd, env: { ...a.env, MEETBLE_WORKER_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = p;
      let out = "", err = "";
      const t = setTimeout(() => { p.kill(); reject(new Error("browser worker did not start")); }, startMs);
      p.stdout!.setEncoding("utf8");
      p.stdout!.on("data", (d: string) => {
        out += d;
        const m = /\{"listening":\s*(\d+)\}/.exec(out);
        if (m) { clearTimeout(t); resolve({ port: Number(m[1]), token }); }
      });
      p.stderr!.on("data", (d) => { err = (err + d).slice(-2000); });
      p.on("error", (e) => { clearTimeout(t); reject(e); });
      p.on("exit", (code) => { clearTimeout(t); reject(new Error(`browser worker exited (${code}): ${err.trim().split(/\r?\n/).pop() ?? ""}`)); this.fail(new Error("browser worker exited")); });
      // Don't keep the Node process alive for the worker; it exits when our end of its stdin closes.
      p.unref(); (p.stdout as unknown as Socket).unref?.(); (p.stderr as unknown as Socket).unref?.(); (p.stdin as unknown as Socket).unref?.();
    });
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m: { id?: number; result?: Record<string, unknown> };
      try { m = JSON.parse(line); } catch { continue; }
      const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
      if (!p) continue;
      this.pending.delete(m.id!);
      p.resolve(m.result && typeof m.result === "object" ? m.result : { error: "empty answer from the browser worker" });
    }
  }

  private fail(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.ready = undefined;
    this.sock = undefined;
  }

  /** Runs one browser task. Aborting the signal (the step's time budget) cancels it in the worker. */
  async call(cmd: string, args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const why = () => (opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error("cancelled"));
    if (opts.signal?.aborted) throw why();
    await this.start();
    if (opts.signal?.aborted) throw why(); // aborted while the worker was starting
    const id = ++this.seq, sock = this.sock!;
    const send = (o: object) => sock.write(JSON.stringify({ token: this.token, ...o }) + "\n");
    return new Promise((resolve, reject) => {
      // Keep Node alive only while a task is out (the socket is unref'd otherwise, so an idle worker never holds the CLI open).
      const done = () => { clearTimeout(t); opts.signal?.removeEventListener("abort", onAbort); if (!this.pending.size) sock.unref(); };
      const cancel = (e: Error) => { if (this.pending.delete(id)) { send({ id: -id, cancel: id }); done(); reject(e); } };
      const onAbort = () => cancel(why());
      const t = setTimeout(() => cancel(new Error(`timed out after ${opts.timeoutMs ?? 300_000} ms`)), opts.timeoutMs ?? 300_000);
      t.unref?.();
      this.pending.set(id, { resolve: (v) => { done(); resolve(v); }, reject: (e) => { done(); reject(e); } });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      sock.ref();
      send({ id, cmd, args });
    });
  }

  close() { try { this.sock?.destroy(); } catch {} try { this.child?.stdin?.end(); } catch {} }
}

let shared: BrowserWorker | undefined;
let sharedKey = "";
let broken = false;

/** The worker for this process: the server's (MEETBLE_BROWSER_WORKER=host:port) or one of our own. */
export function browserWorker(python: string, script: string, cwd: string, env: NodeJS.ProcessEnv): BrowserWorker | undefined {
  const w = env.MEETBLE_BROWSER_WORKER;
  if (w === "0" || w === "off" || broken) return undefined;
  const key = w || `${python}|${script}`;
  if (shared && sharedKey === key) return shared;
  const m = w ? /^([\w.-]+):(\d+)$/.exec(w) : null;
  if (w && (!m || !env.MEETBLE_WORKER_TOKEN)) return undefined;
  shared?.close();
  shared = m ? new BrowserWorker({ host: m[1]!, port: Number(m[2]), token: env.MEETBLE_WORKER_TOKEN! }) : new BrowserWorker({ python, script, cwd, env });
  sharedKey = key;
  return shared;
}

/** The worker couldn't start (old browser_tools.py, no asyncio server...): use one process per task from now on. */
export function markWorkerBroken() { broken = true; shared?.close(); shared = undefined; }

/** For tests. */
export function resetBrowserWorker() { shared?.close(); shared = undefined; sharedKey = ""; broken = false; }
