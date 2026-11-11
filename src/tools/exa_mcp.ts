// Keyless fallback: Exa's public MCP endpoint (free tier, no API key).
// Used only when EXA_API_KEY is not set. Speaks MCP "streamable HTTP" (JSON-RPC over POST; reply may be JSON or SSE).
// NOT verified live from the build machine (network blocked); test locally with: npm run exa:smoke
import { HttpError, TimeoutError } from "../core/errors.js";
import type { ToolContext } from "../core/types.js";
import type { ExaResult } from "./exa.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const TOOL = "web_search_exa";

let sessionId: string | undefined;
let rpcId = 0;
// One handshake shared by concurrent callers: tools run in parallel, and each starting its own
// initialize would race on sessionId.
let initPromise: Promise<void> | undefined;

async function rpc(ctx: ToolContext, method: string, params: unknown, notify = false): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45_000);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const msg = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params };
    const res = await ctx.fetch(EXA_MCP_URL, { method: "POST", headers, body: JSON.stringify(msg), signal: ac.signal });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new HttpError("exa-mcp", res.status, EXA_MCP_URL, text);
    if (notify) return undefined;
    const payload = parseRpcBody(text);
    if (payload?.error) throw new HttpError("exa-mcp", 200, EXA_MCP_URL, JSON.stringify(payload.error));
    return payload?.result;
  } catch (e) {
    if (ac.signal.aborted) throw new TimeoutError("exa-mcp", 45_000);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Body is either a JSON-RPC object or an SSE stream whose `data:` lines hold JSON-RPC objects. */
export function parseRpcBody(text: string): any {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  let last: any;
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (!d) continue;
    try {
      const obj = JSON.parse(d);
      if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
    } catch { /* ignore keep-alives */ }
  }
  return last;
}

/** Parse the tool's text output into results. Accepts a JSON payload or "Title:/URL:/Published Date:/Text:" blocks. */
export function parseMcpResults(text: string): ExaResult[] {
  const t = text.trim();
  try {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
    return arr.filter((r: any) => typeof r?.url === "string").map((r: any) => ({
      url: r.url, title: r.title ?? null, publishedDate: r.publishedDate ?? null, author: r.author ?? null,
      text: typeof r.text === "string" ? r.text : undefined,
      highlights: Array.isArray(r.highlights) ? r.highlights : undefined,
      summary: typeof r.summary === "string" ? r.summary : undefined,
    }));
  } catch { /* not JSON: fall through to text blocks */ }
  const out: ExaResult[] = [];
  // The hosted server joins results with "\n\n---\n\n" and prints "N/A" for missing fields; older
  // builds just started each result with "Title:".
  const blocks = /\n\n---\n\n/.test(t) ? t.split(/\n\n---\n\n/) : t.split(/\n(?=Title:)/);
  const field = (b: string, re: RegExp) => {
    const v = b.match(re)?.[1]?.trim();
    return v && v !== "N/A" ? v : null;
  };
  for (const b of blocks) {
    const url = b.match(/^URL:\s*(\S+)/m)?.[1];
    if (!url || !/^https?:\/\//.test(url)) continue;
    const title = field(b, /^Title:\s*(.*)$/m);
    const date = field(b, /^Published(?: Date)?:\s*(.*)$/m);
    const author = field(b, /^Author:\s*(.*)$/m);
    // Body is "Highlights:\n<one per line>" when the server has highlights, else "Text: <page text>".
    const hl = b.match(/^Highlights:[ \t]*\n?([\s\S]*)$/m)?.[1]?.trim();
    const highlights = hl ? hl.split(/\n+/).map((h) => h.trim()).filter(Boolean) : undefined;
    const textM = b.match(/^Text:\s*([\s\S]*)$/m)?.[1]?.trim() ?? hl;
    out.push({
      url, title, publishedDate: date && !Number.isNaN(Date.parse(date)) ? date : null, author, text: textM,
      ...(highlights?.length ? { highlights } : {}),
    });
  }
  return out;
}

export async function exaMcpSearch(query: string, numResults: number, ctx: ToolContext): Promise<ExaResult[]> {
  if (!initPromise) {
    initPromise = (async () => {
      await rpc(ctx, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "hack-finder", version: "0.1.0" },
      });
      await rpc(ctx, "notifications/initialized", {}, true).catch(() => undefined);
    })().catch((e) => { initPromise = undefined; throw e; }); // failed handshake: let the next call retry
  }
  await initPromise;
  const result = await rpc(ctx, "tools/call", { name: TOOL, arguments: { query, numResults } });
  const texts: string[] = Array.isArray(result?.content)
    ? result.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text)
    : [];
  // MCP reports tool failures (rate limit, upstream error) as a normal result with isError: true.
  if (result?.isError) throw new Error(`exa-mcp tool error: ${(texts.join(" ") || "unknown").slice(0, 200)}`);
  return texts.flatMap(parseMcpResults);
}

export function resetExaMcpSession() { sessionId = undefined; rpcId = 0; initPromise = undefined; }
