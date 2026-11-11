import { MissingKeyError } from "../core/errors.js";
import type { Target, ToolContext } from "../core/types.js";
import { exaSearch, type ExaResult, type ExaSearchParams } from "./exa.js";

// Step 0: work out who the target is (company, role, profiles).
// This file also exports the small research helpers shared by the Step 1/2 Exa tools
// (URL dedupe, date validation, name matching, parallel search with partial-failure accounting).

/* ------------------------------------------------------------------ shared helpers */

/** Canonical form of a URL for dedupe: lowercase host without www, no hash, no trailing slash, no utm_* params. */
export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (k.toLowerCase().startsWith("utm_")) x.searchParams.delete(k);
    const host = x.hostname.toLowerCase().replace(/^www\./, "");
    const path = x.pathname.replace(/\/+$/, "");
    const qs = x.searchParams.toString();
    return `${host}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return u.trim();
  }
}

export interface Tagged { r: ExaResult; q: number } // q = index of the query that first returned it

/** Merges result lists from several queries, keeping the first occurrence of each URL. */
export function dedupeByUrl(lists: ExaResult[][]): Tagged[] {
  const seen = new Set<string>();
  const out: Tagged[] = [];
  lists.forEach((list, q) => {
    for (const r of list) {
      if (!r || typeof r.url !== "string") continue;
      const k = normUrl(r.url);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ r, q });
    }
  });
  return out;
}

/** Returns YYYY-MM-DD for a parseable date string with a plausible year, else undefined. */
export function toIsoDate(s: unknown): string | undefined {
  if (typeof s !== "string" || !s.trim()) return undefined;
  const t = Date.parse(s.trim());
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2100) return undefined;
  return d.toISOString().slice(0, 10);
}

export function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function nameTokens(name: string): string[] {
  return fold(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when every token of the name appears as a whole word in the text. */
export function mentionsName(text: string | null | undefined, name: string): boolean {
  if (!text) return false;
  const toks = nameTokens(name);
  if (!toks.length) return false;
  const hay = fold(text);
  return toks.every((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(hay));
}

/** All searchable text of a result; tolerates null/missing fields. */
export function haystack(r: ExaResult): string {
  const parts: string[] = [];
  for (const v of [r.title, r.author, r.summary, r.text]) if (typeof v === "string") parts.push(v);
  if (Array.isArray(r.highlights)) for (const h of r.highlights) if (typeof h === "string") parts.push(h);
  return parts.join("\n");
}

export function clip(s: string, n = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface SearchAllResult { lists: ExaResult[][]; failed: number; errors: unknown[] }

/**
 * Runs several Exa searches in parallel. A missing key is rethrown (the step is "skipped");
 * if every search fails the first error is rethrown; otherwise partial results are returned
 * and `failed` says how many searches failed so the checklist note can say so.
 */
export async function searchAll(params: ExaSearchParams[], ctx: ToolContext): Promise<SearchAllResult> {
  const settled = await Promise.allSettled(params.map((p) => exaSearch(p, ctx)));
  const errors = settled.flatMap((s) => (s.status === "rejected" ? [s.reason] : []));
  const missing = errors.find((e) => e instanceof MissingKeyError);
  if (missing) throw missing;
  if (params.length > 0 && errors.length === params.length) throw errors[0];
  const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : []));
  return { lists, failed: errors.length, errors };
}

export function failedNote(failed: number, total: number): string {
  return failed > 0 ? ` (${failed} of ${total} searches failed)` : "";
}

/* ------------------------------------------------------------------ resolve_target */

export interface ResolveTargetInput { name: string; hint?: string }
export interface Candidate { name: string; role?: string; company?: string; url: string }
export interface ResolveTargetResult {
  target: Target;
  candidates: Candidate[];
  ambiguous: boolean;
  failed_queries: number;
}

const ROLE_WORDS = /\b(founder|co-?founder|ceo|cto|coo|cfo|partner|engineer|director|head|vp|vice president|manager|investor|president|chair|principal|advisor|lead|chief|gp|managing)\b/i;
const SOCIAL_HOSTS = ["linkedin.com", "x.com", "twitter.com", "facebook.com", "instagram.com", "youtube.com", "medium.com", "substack.com", "github.com", "crunchbase.com", "wikipedia.org", "threads.net", "tiktok.com"];
const X_RESERVED = new Set(["home", "search", "intent", "share", "i", "hashtag", "explore", "settings", "login", "signup", "messages", "notifications", "status", "compose", "tos", "privacy", "about"]);
const STOP = new Set(["the", "and", "for", "with", "from", "who", "his", "her", "inc", "llc"]);

function isSocialHost(host: string): boolean {
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** linkedin.com/in/<slug> → canonical https://www.linkedin.com/in/<slug> (any locale subdomain). */
export function linkedinProfile(u: string): { url: string; slug: string } | undefined {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase();
    if (!(host === "linkedin.com" || host.endsWith(".linkedin.com"))) return undefined;
    const m = x.pathname.match(/^\/in\/([^/?#]+)\/?/i);
    if (!m?.[1]) return undefined;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    return { url: `https://www.linkedin.com/in/${slug}`, slug };
  } catch {
    return undefined;
  }
}

/** Handle from an x.com / twitter.com profile URL. Status, intent and other non-profile paths return undefined. */
export function xHandleFromUrl(u: string): string | undefined {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
    if (host !== "x.com" && host !== "twitter.com") return undefined;
    const segs = x.pathname.split("/").filter(Boolean);
    if (segs.length !== 1 || !segs[0]) return undefined; // /handle only; /handle/status/123 is a post, not a profile
    const handle = decodeURIComponent(segs[0]).replace(/^@/, "");
    if (X_RESERVED.has(handle.toLowerCase())) return undefined;
    return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : undefined;
  } catch {
    return undefined;
  }
}

// Profile-site suffixes seen in live titles, e.g. "Boris Jabes - Visiting Partner @ Y Combinator - Crunchbase Person Profile".
const SITE_SUFFIX = /\s*[|\-–—]\s*(Crunchbase( Person Profile)?|Wellfound|AngelList|PitchBook|Bloomberg|ZoomInfo|RocketReach|Signal|The Org)\s*$/i;

/** "Boris Jabes - Partner at Y Combinator | LinkedIn" → {name, role, company}. */
export function parseProfileTitle(title: string | null | undefined): { name: string; role?: string; company?: string } | undefined {
  if (typeof title !== "string" || !title.trim()) return undefined;
  const t = title
    .replace(SITE_SUFFIX, "")
    .replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, "")
    .replace(/\s+on LinkedIn.*$/i, "")
    .replace(/\s*\/\s*(X|Twitter)\s*$/i, "")
    .trim();
  const parts = t.split(/\s+[|\-–—·]\s+/).map((p) => p.trim()).filter(Boolean);
  const name = (parts[0] ?? "").replace(/\s*\(@?[A-Za-z0-9_]+\)\s*$/, "").trim();
  if (!name) return undefined;
  const headline = parts.slice(1).join(", ");
  if (!headline) return { name };
  const at = headline.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at?.[1] && at[2]) return { name, role: at[1].trim(), company: at[2].split(/,\s*/)[0]!.trim() };
  const comma = headline.split(/,\s*/);
  if (comma.length >= 2 && comma[0] && comma[1]) {
    return ROLE_WORDS.test(comma[0]) ? { name, role: comma[0], company: comma[1] } : { name, company: comma[0], role: comma[1] };
  }
  return ROLE_WORDS.test(headline) ? { name, role: headline } : { name, company: headline };
}

function companyKey(c: string): string {
  return fold(c).replace(/[^a-z0-9]/g, "");
}

/** Finds a result host whose main label equals the company name, e.g. "Y Combinator" → ycombinator.com. */
function findCompanyDomain(company: string, results: ExaResult[]): string | undefined {
  const key = companyKey(company);
  if (key.length < 3) return undefined;
  for (const r of results) {
    const host = hostOf(r.url);
    if (!host || isSocialHost(host)) continue;
    const labels = host.split(".");
    const main = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    if (main === key) return labels.slice(-2).join(".");
  }
  return undefined;
}

function hintTokens(hint?: string): string[] {
  if (!hint) return [];
  return fold(hint).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

export async function resolve_target(input: ResolveTargetInput, ctx: ToolContext): Promise<ResolveTargetResult> {
  const name = (input?.name ?? "").trim();
  if (!name) throw new Error("resolve_target: name is required");
  const hint = input.hint?.trim() || undefined;
  const q = hint ? `${name} ${hint}` : name;

  const { lists, failed } = await searchAll(
    [
      // "people" does not support date filters or excludeDomains (400), so none are sent.
      { query: q, category: "people", numResults: 10, text: { maxCharacters: 1000 } },
      { query: `${q} X (Twitter) profile`, includeDomains: ["x.com", "twitter.com"], numResults: 5 },
      { query: q, category: "personal site", numResults: 5 },
    ],
    ctx,
  );
  const all = dedupeByUrl(lists);
  const hints = hintTokens(hint);
  const matchesHint = (r: ExaResult) => hints.length > 0 && hints.some((h) => fold(haystack(r)).includes(h));

  // Candidates: people-like results (people search + any LinkedIn profile) whose title names the target.
  interface Cand extends Candidate { r: ExaResult; slug?: string; hint: boolean }
  const cands: Cand[] = [];
  for (const { r, q: qi } of all) {
    const li = linkedinProfile(r.url);
    if (qi !== 0 && !li) continue;
    const p = parseProfileTitle(r.title);
    if (!p || !mentionsName(p.name, name)) continue;
    cands.push({ name: p.name, role: p.role, company: p.company, url: li?.url ?? r.url, r, slug: li?.slug, hint: matchesHint(r) });
  }
  const pool = hints.length && cands.some((c) => c.hint) ? cands.filter((c) => c.hint) : cands;
  const slugs = new Set(pool.flatMap((c) => (c.slug ? [c.slug] : [])));
  const ambiguous = slugs.size >= 2;
  // The hint narrows candidates, but a bare LinkedIn title ("Boris Jabes") can't match a hint, so a
  // hint-only pool may hold no LinkedIn profile. If exactly one LinkedIn profile exists overall, keep it.
  const allSlugs = new Set(cands.flatMap((c) => (c.slug ? [c.slug] : [])));
  const best = pool.find((c) => c.slug) ?? (allSlugs.size === 1 ? cands.find((c) => c.slug) : undefined) ?? pool[0];

  const target: Target = { name };
  if (best) {
    if (best.role) target.role = best.role;
    if (best.company) target.company = best.company;
    if (best.slug) target.linkedin_url = best.url;
  }
  // The chosen LinkedIn result often has a bare title ("Boris Jabes"), so role/company come back empty.
  // Take them from another result whose title names the same person (Crunchbase, Wellfound...), preferring hint matches.
  if (!target.company) {
    const titled = all
      .map(({ r }) => ({ r, p: parseProfileTitle(r.title) }))
      .filter((x) => x.p && x.p.company && mentionsName(x.p.name, name) && x.p.name.split(/\s+/).length <= 4);
    const pick = titled.find((x) => matchesHint(x.r)) ?? titled[0];
    if (pick?.p?.company) {
      target.company = pick.p.company;
      if (pick.p.role && !target.role) target.role = pick.p.role;
      ctx.findings.save({ step: "step0", tool: "resolve_target", kind: "identity", claim: `${name} is ${[pick.p.role, pick.p.company].filter(Boolean).join(" at ")}`, source_url: pick.r.url, confidence: "medium", data: { from: "profile title" } });
    }
  }
  if (target.company) {
    const d = findCompanyDomain(target.company, all.map((t) => t.r));
    if (d) target.company_domain = d;
  }

  // X handle: profile URLs only, and the page must name the target.
  for (const { r } of all) {
    const h = xHandleFromUrl(r.url);
    if (h && mentionsName(haystack(r), name)) {
      target.x_handle = h;
      ctx.findings.save({ step: "step0", tool: "resolve_target", kind: "profile", claim: `${name}'s X profile is @${h}`, source_url: r.url, confidence: ambiguous ? "medium" : "high", data: { platform: "x", handle: h } });
      break;
    }
  }

  // Website: a personal-site result on a non-social host whose domain contains part of the target's name.
  const toks = nameTokens(name).filter((t) => t.length >= 3);
  for (const { r, q: qi } of all) {
    if (qi !== 2) continue;
    const host = hostOf(r.url);
    if (!host || isSocialHost(host)) continue;
    if (!toks.some((t) => host.replace(/[^a-z0-9.]/g, "").includes(t))) continue;
    if (!mentionsName(haystack(r), name)) continue;
    target.website = `https://${host}`;
    ctx.findings.save({ step: "step0", tool: "resolve_target", kind: "profile", claim: `${name}'s personal website is ${host}`, source_url: r.url, confidence: "medium", data: { platform: "website" } });
    break;
  }

  if (best) {
    const desc = [best.role, best.company].filter(Boolean).join(" at ");
    ctx.findings.save({
      step: "step0",
      tool: "resolve_target",
      kind: "identity",
      claim: desc ? `${name} is ${desc}` : `${name} profile found`,
      source_url: best.url,
      confidence: ambiguous ? "low" : best.slug ? "high" : "medium",
      data: { ambiguous, candidates: pool.length },
    });
    if (target.linkedin_url) {
      ctx.findings.save({ step: "step0", tool: "resolve_target", kind: "profile", claim: `${name}'s LinkedIn profile`, source_url: target.linkedin_url, confidence: ambiguous ? "low" : "high", data: { platform: "linkedin" } });
    }
  }

  const candidates: Candidate[] = pool.slice(0, 5).map(({ name: n, role, company, url }) => ({ name: n, ...(role ? { role } : {}), ...(company ? { company } : {}), url }));
  return { target, candidates, ambiguous, failed_queries: failed };
}

export function summarizeResolveTarget(r: ResolveTargetResult): string {
  if (!r.candidates.length) return `no profile found${failedNote(r.failed_queries, 3)}`;
  const t = r.target;
  const who = [t.role, t.company].filter(Boolean).join(" at ") || t.name;
  const extras = [t.x_handle ? `@${t.x_handle}` : "", t.linkedin_url ? "LinkedIn" : ""].filter(Boolean).join(", ");
  const amb = r.ambiguous ? `; ambiguous: ${r.candidates.length} candidates` : "";
  return `${who}${extras ? ` (${extras})` : ""}${amb}${failedNote(r.failed_queries, 3)}`;
}
