// Usage: node dist/cli.js "Boris Jabes" --deadline 2026-11-20 [--hint "YC partner"] [--x-handle borisjabes] [--profile user_profile.json] [--out out/research.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadDotEnv } from "./core/env.js";
import { FindingStore } from "./core/findings.js";
import type { Env, StepEvent, ToolContext } from "./core/types.js";
import { runResearch } from "./pipeline.js";
import { isYmd } from "./tools/xai.js";

// Not process.loadEnvFile: it only exists on Node 20.12+/21.7+, and the CLI must run on Node 18.
loadDotEnv(".env");
if (typeof fetch !== "function") {
  console.error(`Node ${process.versions.node} has no built-in fetch. Use Node 18 or newer.`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const name = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));
if (!name) {
  console.error('Usage: node dist/cli.js "<person name>" [--deadline YYYY-MM-DD] [--hint "..."] [--x-handle handle] [--event-url URL ...] [--profile user_profile.json] [--out out/research.json]');
  process.exit(1);
}
const deadline = arg("deadline") ?? new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
// isYmd, not Date.parse: Date.parse("2026-02-30") rolls over to March 2 instead of failing.
if (!isYmd(deadline)) {
  console.error(`Invalid --deadline "${deadline}" (use YYYY-MM-DD)`);
  process.exit(1);
}
const out = arg("out") ?? "out/research.json";
const profilePath = arg("profile") ?? "user_profile.json";
let offerInventory: unknown[] = [];
let profileEvents: string[] = []; // user_profile.json my_events: [{url}] or [url]
if (existsSync(profilePath)) {
  try {
    const p = JSON.parse(readFileSync(profilePath, "utf8").replace(/^\uFEFF/, "")); // strip BOM (Windows editors)
    offerInventory = Array.isArray(p.offer_inventory) ? p.offer_inventory : Array.isArray(p.offer_inventory_draft) ? p.offer_inventory_draft : [];
    if (Array.isArray(p.my_events)) profileEvents = p.my_events.map((e: unknown) => (typeof e === "string" ? e : (e as { url?: unknown })?.url)).filter((u: unknown): u is string => typeof u === "string");
  } catch (e) {
    console.error(`Could not read ${profilePath}: ${(e as Error).message}`);
  }
}

// Windows PowerShell 5 consoles often can't draw emoji, so use ASCII there (HF_EMOJI=1 forces emoji).
const EMOJI = process.platform !== "win32" || process.env.HF_EMOJI === "1";
const ICON: Record<StepEvent["status"], string> = EMOJI
  ? { running: "⏳", done: "✅", error: "❌", skipped: "⏭️" }
  : { running: "[..]", done: "[ok]", error: "[x]", skipped: "[--]" };
const events: StepEvent[] = [];
const env: Env = {
  EXA_API_KEY: process.env.EXA_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  MODEL_API_KEY: process.env.MODEL_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  HUNTER_API_KEY: process.env.HUNTER_API_KEY,
};
const ctx: ToolContext = {
  fetch: (u, i) => fetch(u, i),
  env,
  now: () => new Date(),
  emit: (e) => {
    events.push(e);
    console.log(`${ICON[e.status]} ${e.label}${e.note ? ` (${e.note})` : ""}`);
  },
  findings: new FindingStore(),
};

const xHandle = arg("x-handle")?.replace(/^@/, "");
console.log(`Meetble: researching ${name} (deadline ${deadline})\n`);
const eventUrls: string[] = [...process.argv.flatMap((a, i) => { const v = process.argv[i + 1]; return a === "--event-url" && v ? [v] : []; }), ...profileEvents];
const result = await runResearch({ name, hint: arg("hint"), deadline, offerInventory, targetOverrides: { x_handle: xHandle }, eventUrls }, ctx);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ ...result, events_log: events }, null, 2), "utf8");
console.log(`\n${result.findings.length} findings saved to ${out}`);
