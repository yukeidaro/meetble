import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = resolve("src/cli.ts");

/** Runs the CLI with tsx in a fresh directory. `node18` removes Node 20.12+ APIs to mimic an older runtime. */
function runCli(args: string[], opts: { env?: string; node18?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hf-cli-"));
  if (opts.env !== undefined) writeFileSync(join(dir, ".env"), opts.env);
  const pre = join(dir, "pre.mjs");
  writeFileSync(pre, opts.node18 ? "delete process.loadEnvFile;\n" : "\n");
  return spawnSync(process.execPath, ["--import", pathToFileUrl(resolve("node_modules/tsx/dist/loader.mjs")), "--import", pathToFileUrl(pre), CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, EXA_API_KEY: "", XAI_API_KEY: "" },
    timeout: 30_000,
  });
}
const pathToFileUrl = (p: string) => pathToFileURL(p).href;

describe("cli", () => {
  it("prints usage and exits 1 with no args", () => {
    const r = runCli([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage");
  }, 30_000);

  it("reads a CRLF .env on runtimes without process.loadEnvFile (Node 18/20.11)", () => {
    const r = runCli(["Boris Jabes", "--deadline", "2026-11-31"], { env: "﻿EXA_API_KEY=k\r\n", node18: true });
    expect(r.stderr).not.toContain("TypeError");
    expect(r.stderr).toContain("Invalid --deadline");
    expect(r.status).toBe(1);
  }, 30_000);

  it("rejects impossible calendar dates that Date.parse rolls over", () => {
    const r = runCli(["Boris Jabes", "--deadline", "2026-02-30"]);
    expect(r.stderr).toContain("Invalid --deadline");
    expect(r.status).toBe(1);
  }, 30_000);
});
