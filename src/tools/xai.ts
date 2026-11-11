import { requestJson, requireKey } from "../core/http.js";
import type { ToolContext } from "../core/types.js";

// xAI Responses API + X Search tool.
// Docs: https://docs.x.ai/developers/tools/x-search
//       https://docs.x.ai/developers/tools/citations
//       https://docs.x.ai/developers/rest-api-reference/inference/responses
// - POST https://api.x.ai/v1/responses, Authorization: Bearer $XAI_API_KEY
// - tools: [{type:"x_search", allowed_x_handles?, excluded_x_handles?, from_date?, to_date?}]
//   handles without "@", max 20, allowed and excluded cannot be combined,
//   dates YYYY-MM-DD (from_date inclusive from 00:00 UTC, to_date EXCLUSIVE; other formats are silently ignored).
// - Inline citations ("[[1]](url)" inside the text) are on by default; we send include:["no_inline_citations"].
// - Response text lives in output[].content[] items of type "output_text"; citations are
//   annotations of type "url_citation" ({url, title, start_index, end_index}). The SDKs also expose a
//   `citations` list; we accept a top-level `citations` array too, in case the REST body carries it.

export const XAI_URL = "https://api.x.ai/v1/responses";
export const XAI_MODEL = "grok-4.7";
export const MAX_X_HANDLES = 20;

export interface XSearchParams {
  prompt: string;
  handles?: string[];          // allowed_x_handles
  excludeHandles?: string[];   // excluded_x_handles
  fromDate?: string;           // YYYY-MM-DD, inclusive
  toDate?: string;             // YYYY-MM-DD, exclusive
}

export interface XSearchResult {
  text: string;
  /** x.com status URLs the model cited, normalized to https://x.com/<user>/status/<id>, deduped. */
  citations: string[];
  /** First JSON object/array found in `text`, or null when there is none or it does not parse. */
  json: unknown;
}

// ---------- handles ----------

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** "@BorisJabes", " borisjabes ", "https://x.com/BorisJabes" -> "BorisJabes". Returns "" when nothing is left. */
export function normalizeHandle(h: string | undefined | null): string {
  if (typeof h !== "string") return "";
  let s = h.trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i);
  if (m) s = m[1] ?? "";
  return s.replace(/^@+/, "").trim();
}

export function sameHandle(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = normalizeHandle(a).toLowerCase();
  return x !== "" && x === normalizeHandle(b).toLowerCase();
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}

function cleanHandleList(list: string[] | undefined, field: string): string[] {
  if (!list) return [];
  if (!Array.isArray(list)) throw new Error(`xai x_search: ${field} must be an array of X handles`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const h = normalizeHandle(raw);
    if (!h) continue;
    if (!isValidHandle(h)) throw new Error(`xai x_search: invalid X handle in ${field}: ${JSON.stringify(raw)}`);
    const k = h.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  if (out.length > MAX_X_HANDLES) {
    throw new Error(`xai x_search: ${field} has ${out.length} handles; the API allows at most ${MAX_X_HANDLES}`);
  }
  return out;
}

// ---------- dates (UTC) ----------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30, full date-times, etc.). */
export function isYmd(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = s.match(DATE_RE);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

/** UTC calendar date `days` before `now`, as YYYY-MM-DD. */
export function ymdDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Normalizes "2026-11-10", "2026-11-10T08:00:00Z" etc. to YYYY-MM-DD (UTC); undefined if unparseable. */
export function toYmd(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  if (isYmd(s)) return s;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return undefined; // only accept ISO date-times, not free text
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

// ---------- X status URLs ----------

const STATUS_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})(?:[/?#].*)?$/i;

export interface StatusRef { url: string; user?: string; id: string }

/** Parses an x.com / twitter.com status URL; returns the canonical https://x.com/... form, or null. */
export function parseStatusUrl(u: unknown): StatusRef | null {
  if (typeof u !== "string") return null;
  const m = u.trim().match(STATUS_RE);
  if (!m) return null;
  const user = m[1];
  const id = m[2]!;
  if (user && user.toLowerCase() === "i") return { url: `https://x.com/i/status/${id}`, id };
  return user ? { url: `https://x.com/${user}/status/${id}`, user, id } : { url: `https://x.com/i/status/${id}`, id };
}

// ---------- JSON extraction ----------

/**
 * Finds the first JSON object/array in model text: tries the whole text, then ```json fences,
 * then the first balanced {...} or [...] (string-aware). Returns null when nothing parses.
 */
export function parseJsonLoose(text: string): unknown {
  if (typeof text !== "string") return null;
  const tryParse = (s: string): unknown => {
    try { return JSON.parse(s); } catch { return undefined; }
  };
  const whole = tryParse(text.trim());
  if (whole !== undefined && typeof whole === "object" && whole !== null) return whole;
  for (const m of text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) {
    const v = tryParse((m[1] ?? "").trim());
    if (v !== undefined && typeof v === "object" && v !== null) return v;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "{" && c !== "[") continue;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    const v = tryParse(text.slice(i, end + 1));
    if (v !== undefined && typeof v === "object" && v !== null) return v;
  }
  return null;
}

function balancedEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

// ---------- Responses API output parsing (shared by xAI and Meta, both follow the Responses shape) ----------

export interface ParsedResponses { text: string; urls: string[] }

/** Concatenates every output_text block and collects every url_citation URL (+ top-level `citations`). */
export function parseResponsesOutput(r: unknown): ParsedResponses {
  const texts: string[] = [];
  const urls: string[] = [];
  const obj = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const output = Array.isArray(obj.output) ? obj.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.type !== "message") continue;
    const content = Array.isArray(it.content) ? it.content : [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      if (cc.type !== "output_text" || typeof cc.text !== "string") continue;
      texts.push(cc.text);
      for (const a of Array.isArray(cc.annotations) ? cc.annotations : []) {
        const aa = (a ?? {}) as Record<string, unknown>;
        if (aa.type === "url_citation" && typeof aa.url === "string") urls.push(aa.url);
      }
    }
  }
  if (texts.length === 0 && typeof obj.output_text === "string") texts.push(obj.output_text);
  if (Array.isArray(obj.citations)) {
    for (const c of obj.citations) {
      if (typeof c === "string") urls.push(c);
      else if (c && typeof c === "object" && typeof (c as { url?: unknown }).url === "string") urls.push((c as { url: string }).url);
    }
  }
  return { text: texts.join("\n"), urls: [...new Set(urls)] };
}

// ---------- client ----------

export function buildXSearchTool(p: XSearchParams): Record<string, unknown> {
  if (typeof p.prompt !== "string" || !p.prompt.trim()) throw new Error("xai x_search: prompt is required");
  const allowed = cleanHandleList(p.handles, "handles");
  const excluded = cleanHandleList(p.excludeHandles, "excludeHandles");
  if (allowed.length && excluded.length) {
    throw new Error("xai x_search: handles (allowed_x_handles) and excludeHandles (excluded_x_handles) cannot both be set");
  }
  if (p.fromDate !== undefined && !isYmd(p.fromDate)) throw new Error(`xai x_search: fromDate must be YYYY-MM-DD, got ${JSON.stringify(p.fromDate)}`);
  if (p.toDate !== undefined && !isYmd(p.toDate)) throw new Error(`xai x_search: toDate must be YYYY-MM-DD, got ${JSON.stringify(p.toDate)}`);
  if (p.fromDate && p.toDate && p.fromDate >= p.toDate) {
    throw new Error(`xai x_search: fromDate (${p.fromDate}) must be before toDate (${p.toDate}); toDate is exclusive`);
  }
  const tool: Record<string, unknown> = { type: "x_search" };
  if (allowed.length) tool.allowed_x_handles = allowed;
  if (excluded.length) tool.excluded_x_handles = excluded;
  if (p.fromDate) tool.from_date = p.fromDate;
  if (p.toDate) tool.to_date = p.toDate;
  return tool;
}

export async function xaiXSearch(p: XSearchParams, ctx: ToolContext): Promise<XSearchResult> {
  const tool = buildXSearchTool(p); // validate before touching the key or the network
  const key = requireKey(ctx.env, "XAI_API_KEY");
  const r = await requestJson<unknown>({
    service: "xai",
    url: XAI_URL,
    headers: { authorization: `Bearer ${key}` },
    // Inline citations are ON by default for REST and insert "[[1]](url)" markers into the answer text,
    // which corrupts the STRICT JSON we ask for. The url_citation annotations still list the sources.
    body: { model: XAI_MODEL, input: [{ role: "user", content: p.prompt }], tools: [tool], include: ["no_inline_citations"] },
    fetch: ctx.fetch,
    signal: ctx.signal,
    timeoutMs: 120_000, // agentic search runs several tool calls server-side
    retries: 1,             // 429/5xx/connection errors only
    retryOnTimeout: false,  // a timed-out agentic search already ran (and was billed) server-side
  });
  const { text, urls } = parseResponsesOutput(r);
  const seen = new Set<string>();
  const citations: string[] = [];
  for (const u of urls) {
    const s = parseStatusUrl(u);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    citations.push(s.url);
  }
  return { text, citations, json: parseJsonLoose(text) };
}

/** Shared prompt suffix: Grok must answer with JSON only. */
export const STRICT_JSON =
  "Respond with STRICT JSON only: no prose, no markdown fences, no comments. " +
  "Use only posts you actually retrieved with X search. Never invent URLs; if you do not have the exact post URL, omit the item.";
