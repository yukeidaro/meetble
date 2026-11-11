import { FindingStore } from "../src/core/findings.js";
import type { Env, FetchLike, StepEvent, ToolContext } from "../src/core/types.js";

export interface RecordedCall { url: string; init?: RequestInit; body?: any }

/** Fake fetch: route(url, body) returns {status, json} or throws. Records every call. */
export function fakeFetch(route: (url: string, body: any, init?: RequestInit) => { status?: number; json?: unknown; text?: string } | Promise<{ status?: number; json?: unknown; text?: string }>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? safeParse(init.body) : undefined;
    calls.push({ url, init, body });
    const r = await route(url, body, init);
    const text = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return s; } }

export function makeCtx(fetch: FetchLike, env: Env = { EXA_API_KEY: "k", XAI_API_KEY: "k", MODEL_API_KEY: "k", HUNTER_API_KEY: "k" }) {
  const events: StepEvent[] = [];
  const ctx: ToolContext = {
    fetch,
    env,
    now: () => new Date("2026-11-11T12:00:00Z"),
    emit: (e) => events.push(e),
    findings: new FindingStore(),
  };
  return { ctx, events };
}
