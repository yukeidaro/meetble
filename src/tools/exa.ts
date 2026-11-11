import { requestJson } from "../core/http.js";
import { exaMcpSearch } from "./exa_mcp.js";
import type { ToolContext } from "../core/types.js";

// Shared Exa client. Docs: https://docs.exa.ai/reference/search
// Agents: verify field names against the docs before relying on them; fix here (one place) if wrong.

export interface ExaSearchParams {
  query: string;
  /** Goal for this search: which documents should rank first, which to exclude, what facts to pull (Exa build-with-exa skill). */
  objective?: string;
  numResults?: number;                 // default 8
  type?: "auto" | "fast";
  category?: string;                   // e.g. "people", "company", "news", "personal site", "linkedin profile", "tweet"
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;         // ISO
  endPublishedDate?: string;
  includeText?: string[];              // phrases that must appear
  text?: boolean | { maxCharacters?: number };
  highlights?: boolean | { maxCharacters?: number; query?: string };
  summary?: boolean | { query?: string };
}

export interface ExaResult {
  id?: string;
  url: string;
  title?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  text?: string;
  highlights?: string[];
  summary?: string;
}

export interface ExaSearchResponse {
  results: ExaResult[];
}

export async function exaSearch(p: ExaSearchParams, ctx: ToolContext): Promise<ExaResult[]> {
  const key = ctx.env.EXA_API_KEY?.trim();
  if (!key) return exaKeylessSearch(p, ctx);
  const { text, highlights, summary, ...rest } = p;
  const contents: Record<string, unknown> = {};
  if (text) contents.text = text === true ? { maxCharacters: 4000 } : text;
  if (highlights) contents.highlights = highlights; // `true` per Exa build-with-exa skill; numSentences/highlightsPerUrl are deprecated
  if (summary) contents.summary = summary === true ? {} : summary;
  const body: Record<string, unknown> = { type: "auto", numResults: 8, ...rest };
  if (Object.keys(contents).length) body.contents = contents;
  const r = await requestJson<ExaSearchResponse>({
    service: "exa",
    url: "https://api.exa.ai/search",
    headers: { "x-api-key": key },
    body,
    fetch: ctx.fetch,
    signal: ctx.signal,
  });
  return Array.isArray(r?.results) ? r.results.filter((x) => typeof x?.url === "string") : [];
}

/**
 * No EXA_API_KEY: use the free public MCP endpoint. It only takes a query and a count, so domain and
 * date filters are applied here after the fact (and site: hints are added to the query).
 */
async function exaKeylessSearch(p: ExaSearchParams, ctx: ToolContext): Promise<ExaResult[]> {
  const n = Math.min(p.numResults ?? 8, 10);
  const sites = p.includeDomains?.length ? " " + p.includeDomains.slice(0, 8).map((d) => `site:${d}`).join(" OR ") : "";
  const raw = await exaMcpSearch(p.query + sites, n, ctx);
  const hostOk = (url: string, domains?: string[]) => {
    if (!domains?.length) return true;
    try {
      const h = new URL(url).hostname.toLowerCase();
      return domains.some((d) => h === d.toLowerCase() || h.endsWith("." + d.toLowerCase()));
    } catch { return false; }
  };
  const start = p.startPublishedDate ? Date.parse(p.startPublishedDate) : NaN;
  const end = p.endPublishedDate ? Date.parse(p.endPublishedDate) : NaN;
  return raw.filter((r) => {
    if (!hostOk(r.url, p.includeDomains)) return false;
    if (p.excludeDomains?.length && hostOk(r.url, p.excludeDomains)) return false;
    if (!Number.isNaN(start) || !Number.isNaN(end)) {
      const d = r.publishedDate ? Date.parse(r.publishedDate) : NaN;
      if (Number.isNaN(d)) return false; // date filter requested but result has no date: drop rather than guess
      if (!Number.isNaN(start) && d < start) return false;
      if (!Number.isNaN(end) && d > end) return false;
    }
    if (p.includeText?.length) {
      const hay = `${r.title ?? ""} ${r.text ?? ""}`.toLowerCase();
      if (!p.includeText.every((t) => hay.includes(t.toLowerCase()))) return false;
    }
    return true;
  });
}
