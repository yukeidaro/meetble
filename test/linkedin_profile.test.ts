import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastJsonObject, linkedinProfile, summarizeLinkedInProfile } from "../src/tools/linkedin_profile.js";
import { fakeFetch, makeCtx } from "./helpers.js";

const target = { name: "Boris Jabes", linkedin_url: "https://www.linkedin.com/in/borisjabes" };
function dir(withPy = true) {
  const d = mkdtempSync(join(tmpdir(), "mb-"));
  writeFileSync(join(d, "browser_tools.py"), "");
  if (withPy) { mkdirSync(join(d, ".venv", "bin"), { recursive: true }); writeFileSync(join(d, ".venv", "bin", "python"), ""); }
  return d;
}

describe("linkedin_profile (computer use)", () => {
  it("parses the last JSON object after log lines", () => {
    expect(lastJsonObject('INFO step 1\n{"a": {"b": 1}}\nINFO\n{\n  "name": "Boris"\n}\n')).toEqual({ name: "Boris" });
  });
  it("skips without venv or script, never throws", async () => {
    const { ctx } = makeCtx(fakeFetch(() => ({})).fetch);
    expect((await linkedinProfile({ target }, ctx, { cwd: dir(false), env: {} })).skipped).toBe(true);
    expect((await linkedinProfile({ target }, ctx, { cwd: mkdtempSync(join(tmpdir(), "mb-")), env: {} })).reason).toMatch(/browser_tools/);
  });
  it("runs browser_tools.py with the LinkedIn URL and saves findings", async () => {
    const { ctx } = makeCtx(fakeFetch(() => ({})).fetch);
    let args: string[] = [];
    const run = async (_c: string, a: string[]) => { args = a; return { code: 0, stderr: "", stdout: 'log\n' + JSON.stringify({ profile_url: "https://www.linkedin.com/in/borisjabes", name: "Boris Jabes", headline: "Visiting Partner at Y Combinator", connection_degree: "2nd", mutual_connections: ["A B", "C D"], recent_activity: ["Posted about agents"], accepts_messages: "Connect only" }, null, 2) }; };
    const r = await linkedinProfile({ target }, ctx, { cwd: dir(), env: {}, run });
    expect(args.slice(1)).toEqual(["linkedin-profile", "https://www.linkedin.com/in/borisjabes"]);
    expect(ctx.findings.all().map((f) => f.kind)).toEqual(["bio", "network", "mutuals", "post"]);
    expect(summarizeLinkedInProfile(r)).toBe("Visiting Partner at Y Combinator, 2nd degree, 2 mutuals");
  });
  it("surfaces a browser failure as an error with the reason", async () => {
    const { ctx } = makeCtx(fakeFetch(() => ({})).fetch);
    const run = async () => ({ code: 1, stdout: "", stderr: "Traceback...\nRuntimeError: Chrome remote debugging is off" });
    await expect(linkedinProfile({ target }, ctx, { cwd: dir(), env: {}, run })).rejects.toThrow(/remote debugging is off/);
  });
});
