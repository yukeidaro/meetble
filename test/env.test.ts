import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, parseDotEnv } from "../src/core/env.js";

describe("parseDotEnv (replaces process.loadEnvFile, which needs Node 20.12+)", () => {
  it("handles BOM, CRLF, comments, export, quotes and inline comments", () => {
    const text =
      "﻿# comment\r\n" +
      "EXA_API_KEY=abc123\r\n" +
      "XAI_API_KEY = \"x y\" \r\n" +
      "MODEL_API_KEY=        # Meta Model API (Muse Spark), optional\r\n" +
      "HUNTER_API_KEY=h1   # optional\r\n" +
      "export ANTHROPIC_API_KEY='sk-#notacomment'\r\n" +
      "MULTI=\"a\\nb\"\r\n" +
      "\r\n" +
      "garbage line\r\n";
    expect(parseDotEnv(text)).toEqual({
      EXA_API_KEY: "abc123",
      XAI_API_KEY: "x y",
      MODEL_API_KEY: "",
      HUNTER_API_KEY: "h1",
      ANTHROPIC_API_KEY: "sk-#notacomment",
      MULTI: "a\nb",
    });
  });

  it("loadDotEnv never overrides variables that are already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-env-"));
    const p = join(dir, ".env");
    writeFileSync(p, "A=from_file\r\nB=from_file\r\n");
    const env: Record<string, string | undefined> = { A: "from_shell" };
    expect(loadDotEnv(p, env)).toBe(true);
    expect(env).toEqual({ A: "from_shell", B: "from_file" });
    expect(loadDotEnv(join(dir, "missing.env"), env)).toBe(false);
  });
});
