import { HttpError, errorNote } from "../core/errors.js";
import { isHttpUrl } from "../core/findings.js";
import { requestJson } from "../core/http.js";
import { exaSearch } from "./exa.js";
import { asciiFold, nameParts } from "./probe_booking_page.js";
import type { Confidence, Target, ToolContext } from "../core/types.js";

// Step 1: work email only. Hunter Email Finder when HUNTER_API_KEY is set; otherwise infer the
// company's address pattern from addresses publicly listed on the web. Nothing here verifies
// deliverability: "medium"/"low" mean "likely", never "verified".

export const TOOL = "guess_work_email";

export type EmailPattern = "first" | "first.last" | "f.last" | "firstlast" | "first_last";
export const PATTERNS: readonly EmailPattern[] = ["first", "first.last", "f.last", "firstlast", "first_last"];

export interface GuessWorkEmailInput {
  target: Target;
}

export interface GuessWorkEmailResult {
  email?: string;
  confidence: Confidence;
  method: "hunter" | "pattern" | "none";
  evidence_urls: string[];
  /** The domain (or company name, for Hunter) we searched. May be stale if the person changed jobs. */
  domain?: string;
  pattern?: EmailPattern;
  /** Distinct public addresses that support `pattern`. */
  examples?: string[];
  /** Hunter score 0-100, when Hunter answered. */
  hunter_score?: number;
  /** Hunter's own verification status, reported as-is (we did not verify). */
  hunter_verification?: string;
  /** Set when Hunter failed and we fell back. */
  hunter_error?: string;
  skipped?: boolean;
  reason?: string;
}

// ---------- Hunter ----------

interface HunterSource { uri?: string; domain?: string }
interface HunterResponse {
  data?: {
    email?: string | null;
    score?: number | null;
    domain?: string | null;
    sources?: HunterSource[] | null;
    verification?: { status?: string | null } | null;
  } | null;
}

/** Docs: https://hunter.io/api-documentation/v2#email-finder  GET /v2/email-finder */
async function hunterFind(target: Target, key: string, ctx: ToolContext): Promise<GuessWorkEmailResult | null> {
  const { first, last } = splitName(target.name);
  const params = new URLSearchParams();
  if (target.company_domain) params.set("domain", target.company_domain);
  else if (target.company) params.set("company", target.company);
  if (first && last) {
    params.set("first_name", first);
    params.set("last_name", last);
  } else {
    params.set("full_name", target.name);
  }
  // Key goes in the X-API-KEY header (documented alternative to ?api_key=) so it never lands in
  // HttpError messages, which include the request URL.
  const url = `https://api.hunter.io/v2/email-finder?${params.toString()}`;
  let r: HunterResponse;
  try {
    r = await requestJson<HunterResponse>({
      service: "hunter",
      url,
      method: "GET",
      headers: { "x-api-key": key },
      body: undefined,
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null; // no match
    throw e;
  }
  const d = r?.data;
  const email = typeof d?.email === "string" && d.email.includes("@") ? d.email.trim() : undefined;
  if (!email) return null;
  const score = typeof d?.score === "number" ? d.score : undefined;
  // Hunter lists search-engine query URLs as "sources" (live run: a google.com/search URL); those are not
  // pages showing the address, so they don't count as evidence.
  const evidence = (d?.sources ?? []).map((s) => s?.uri).filter(isHttpUrl).filter((u) => !isSearchEngineUrl(u));
  // Hunter's own signals only; we never verify. "high" needs Hunter-verified + high score + public sources.
  const verified = d?.verification?.status === "valid";
  const confidence: Confidence =
    score !== undefined && score >= 90 && verified && evidence.length ? "high" : score !== undefined && score >= 70 ? "medium" : "low";
  return {
    email,
    confidence,
    method: "hunter",
    evidence_urls: [...new Set(evidence)],
    domain: d?.domain ?? target.company_domain ?? target.company,
    hunter_score: score,
    hunter_verification: d?.verification?.status ?? undefined,
  };
}

// ---------- pattern inference ----------

/** First/last for email purposes: ASCII, letters/digits only (o'brien -> obrien, jean-luc -> jeanluc). */
export function splitName(name: string): { first?: string; last?: string } {
  const { first, last } = nameParts(name);
  const clean = (s?: string) => (s ? s.replace(/[^a-z0-9]/g, "") || undefined : undefined);
  return { first: clean(first), last: clean(last) };
}

export function applyPattern(p: EmailPattern, first: string, last: string | undefined, domain: string): string | undefined {
  const local =
    p === "first" ? first
    : !last ? undefined
    : p === "first.last" ? `${first}.${last}`
    : p === "f.last" ? `${first[0]}.${last}`
    : p === "firstlast" ? `${first}${last}`
    : `${first}_${last}`;
  return local ? `${local}@${domain}` : undefined;
}

const ROLE_LOCALS = new Set([
  "info", "hello", "hi", "hey", "contact", "press", "media", "pr", "support", "help", "team", "sales", "jobs",
  "careers", "admin", "privacy", "security", "legal", "noreply", "no-reply", "donotreply", "partners",
  "partnerships", "founders", "marketing", "billing", "accounts", "office", "events", "community", "feedback",
  "abuse", "webmaster", "postmaster", "hr", "recruiting", "invest", "investors", "apply", "news", "dpo", "compliance",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches addresses at exactly `domain` (not sub.domain, not domain.evil.com). Group 1 = local part. */
function addressRegex(domain: string): RegExp {
  return new RegExp(`(?<![a-z0-9._%+-])([a-z0-9][a-z0-9._%+-]*)@${escapeRe(domain)}(?![a-z0-9-]|\\.[a-z0-9])`, "gi");
}

/** All addresses at exactly `domain` found in text, lowercased. */
export function extractAddresses(text: string, domain: string): string[] {
  return [...text.matchAll(addressRegex(domain))].map((m) => `${m[1]!.toLowerCase()}@${domain.toLowerCase()}`);
}

/** "First Last" pairs written near an address, folded to ASCII lowercase letters. */
function namesNear(text: string, index: number): Array<{ first: string; last: string }> {
  const win = text.slice(Math.max(0, index - 200), index + 200);
  const out: Array<{ first: string; last: string }> = [];
  // Lookahead keeps pairs overlapping: "Contact Jane Doe" yields both "Contact Jane" and "Jane Doe".
  for (const m of win.matchAll(/(?<![\p{L}'’-])(\p{Lu}[\p{L}'’-]+)(?=\s+(?:\p{Lu}\.\s+)?(\p{Lu}[\p{L}'’-]+))/gu)) {
    const first = asciiFold(m[1]!).replace(/[^a-z0-9]/g, "");
    const last = asciiFold(m[2]!).replace(/[^a-z0-9]/g, "");
    if (first.length >= 2 && last.length >= 2) out.push({ first, last });
  }
  return out;
}

/**
 * Classifies one address's local part. Uses names written near the address when available
 * (resolves "jsmith" vs "john"); otherwise only unambiguous separator shapes count.
 */
export function classifyLocal(local: string, nearby: Array<{ first: string; last: string }>): EmailPattern | undefined {
  if (ROLE_LOCALS.has(local)) return undefined;
  for (const n of nearby) {
    for (const p of PATTERNS) {
      if (applyPattern(p, n.first, n.last, "x")?.split("@")[0] === local) return p;
    }
  }
  let m = /^([a-z]+)\.([a-z]{2,})$/.exec(local);
  if (m) return m[1]!.length === 1 ? "f.last" : "first.last";
  m = /^([a-z]{2,})_([a-z]{2,})$/.exec(local);
  if (m) return "first_last";
  return undefined; // "boris", "bjabes", "borisjabes" are ambiguous without a name next to them
}

interface Example { address: string; pattern: EmailPattern; url: string }

export function inferPattern(
  pages: Array<{ url: string; text: string }>,
  domain: string,
): { pattern?: EmailPattern; examples: Example[]; tie: boolean } {
  const byAddress = new Map<string, Example>();
  for (const pg of pages) {
    for (const m of pg.text.matchAll(addressRegex(domain))) {
      const local = m[1]!.toLowerCase();
      const address = `${local}@${domain.toLowerCase()}`;
      if (byAddress.has(address)) continue;
      const pattern = classifyLocal(local, namesNear(pg.text, m.index ?? 0));
      if (pattern) byAddress.set(address, { address, pattern, url: pg.url });
    }
  }
  const examples = [...byAddress.values()];
  const counts = new Map<EmailPattern, number>();
  for (const e of examples) counts.set(e.pattern, (counts.get(e.pattern) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top) return { examples, tie: false };
  const tie = ranked.length > 1 && ranked[1]![1] === top[1];
  return { pattern: top[0], examples: examples.filter((e) => e.pattern === top[0]), tie };
}

async function patternGuess(target: Target, domain: string, ctx: ToolContext): Promise<GuessWorkEmailResult> {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const hits = await exaSearch(
    {
      query: `email addresses @${d}`,
      includeText: [`@${d}`],
      numResults: 10,
      text: { maxCharacters: 6000 },
    },
    ctx,
  );
  const pages = hits
    .filter((h) => isHttpUrl(h.url))
    .map((h) => ({ url: h.url, text: [h.title ?? "", h.text ?? "", ...(h.highlights ?? [])].join("\n") }));
  const { pattern, examples, tie } = inferPattern(pages, d);
  const { first, last } = splitName(target.name);
  const email = pattern && first ? applyPattern(pattern, first, last, d) : undefined;
  if (!pattern || !email) {
    return {
      confidence: "low",
      method: "none",
      evidence_urls: [],
      domain: d,
      reason: !pattern ? `no personal addresses at @${d} found publicly` : `pattern ${pattern} needs a last name`,
    };
  }
  const urls = [...new Set(examples.map((e) => e.url))];
  return {
    email,
    confidence: examples.length >= 2 && !tie ? "medium" : "low",
    method: "pattern",
    evidence_urls: urls,
    domain: d,
    pattern,
    examples: examples.map((e) => e.address),
  };
}

// ---------- tool ----------

export async function guess_work_email(input: GuessWorkEmailInput, ctx: ToolContext): Promise<GuessWorkEmailResult> {
  const { target } = input;
  const hunterKey = ctx.env.HUNTER_API_KEY?.trim();
  const domain = target.company_domain?.trim() || undefined;

  if (!domain && !(hunterKey && target.company)) {
    const reason = hunterKey ? "no company domain or company name" : "no HUNTER_API_KEY and no company domain";
    return { skipped: true, reason, confidence: "low", method: "none", evidence_urls: [] };
  }

  let result: GuessWorkEmailResult | null = null;
  let hunterError: string | undefined;
  if (hunterKey) {
    try {
      result = await hunterFind(target, hunterKey, ctx);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      if (!domain) throw e; // nothing to fall back to: surface the Hunter error
      hunterError = errorNote(e);
    }
  }

  if (!result && domain) {
    const hunterPart = hunterKey ? (hunterError ? `Hunter failed (${hunterError})` : "Hunter found no match") : undefined;
    try {
      result = await patternGuess(target, domain, ctx);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      // Hunter gave a clean "no match": report that plus the search failure instead of erroring the step.
      // If nothing succeeded at all (no Hunter, or Hunter also failed), surface the error.
      if (!hunterKey || hunterError) throw e;
      result = { confidence: "low", method: "none", evidence_urls: [], domain, reason: `pattern search failed (${errorNote(e)})` };
    }
    if (hunterPart && !result.email) result.reason = result.reason ? `${hunterPart}; ${result.reason}` : hunterPart;
    if (hunterError) result.hunter_error = hunterError;
  }

  if (!result) {
    result = {
      confidence: "low",
      method: "none",
      evidence_urls: [],
      domain: domain ?? target.company,
      reason: "Hunter found no match",
    };
  }

  const src = result.evidence_urls[0];
  if (result.email && src) {
    const how =
      result.method === "hunter"
        ? `Hunter Email Finder (score ${result.hunter_score ?? "n/a"}; not verified by us)`
        : `inferred ${result.pattern}@ pattern from ${result.examples?.length ?? 0} public address(es) at ${result.domain}; not verified`;
    ctx.findings.save({
      step: "step1",
      tool: TOOL,
      kind: "email",
      claim: `Likely work email for ${target.name}: ${result.email} (${how}).`,
      source_url: src,
      confidence: result.confidence,
      data: {
        email: result.email,
        method: result.method,
        domain: result.domain,
        pattern: result.pattern,
        examples: result.examples,
        hunter_score: result.hunter_score,
        hunter_verification: result.hunter_verification,
      },
    });
  }
  return result;
}

export function isSearchEngineUrl(u: string): boolean {
  try {
    const x = new URL(u);
    const h = x.hostname.toLowerCase().replace(/^www\./, "");
    return /^(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$/.test(h) && /^\/(search|html)?\/?$/.test(x.pathname);
  } catch { return false; }
}

export function summarizeGuessWorkEmail(r: GuessWorkEmailResult): string {
  if (r.skipped) return `skipped: ${r.reason}`;
  if (!r.email) return `no work email${r.reason ? ` (${r.reason})` : ""}${r.hunter_error ? `; hunter: ${r.hunter_error}` : ""}`;
  const how =
    r.method === "hunter"
      ? `Hunter score ${r.hunter_score ?? "n/a"}`
      : `pattern ${r.pattern} from ${r.examples?.length ?? 0} example${r.examples?.length === 1 ? "" : "s"}`;
  // Say who verified what: Hunter's own check may say "valid"; we never send mail to test it.
  const check = r.method === "hunter" && r.hunter_verification ? `Hunter check: ${r.hunter_verification}` : "unverified";
  return `${r.email} (${how}, ${r.confidence} confidence, ${check})`;
}
