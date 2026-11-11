import { errorNote } from "../core/errors.js";
import { exaSearch, type ExaResult } from "./exa.js";
import type { Confidence, Target, ToolContext } from "../core/types.js";

// Step 2: find a public booking page (Calendly, Cal.com, ...) or a paid consult page.
// Order: bio links (strongest) -> Exa search on booking domains -> Exa search on paid platforms
// -> as a last resort, guess URL patterns and accept a page only if it names the target.

export const TOOL = "probe_booking_page";

/** Free booking domains. Subdomains count (www.calendly.com, app.cal.com); look-alikes do not. */
export const BOOKING_DOMAINS = [
  "calendly.com",
  "cal.com",
  "savvycal.com",
  "zcal.co",
  "tidycal.com",
  "meetings.hubspot.com",
  "calendar.app.google",
  "calendar.google.com",
] as const;

export const PAID_DOMAINS = ["intro.co", "clarity.fm", "topmate.io", "adplist.org"] as const;

/** First path segments on booking domains that are marketing/app pages, not someone's booking page. */
const RESERVED_SEGMENTS = new Set([
  "", "blog", "pricing", "features", "resources", "integrations", "login", "signin", "sign-in", "signup",
  "sign-up", "signup-flow", "about", "customers", "solutions", "enterprise", "help", "support", "legal",
  "privacy", "terms", "security", "careers", "jobs", "docs", "templates", "product", "products",
  "use-cases", "partners", "contact", "press", "app", "apps", "download", "community", "learn",
  "events", "webinars", "compare", "teams", "integration", "marketplace", "explore", "search", "en",
]);

const MAX_PROBES = 5;
const PROBE_TIMEOUT_MS = 8_000;

export interface ProbeBookingInput {
  target: Target;
  bioLinks?: string[];
}

export type PageSource = "bio" | "search" | "probe";

export interface BookingPage {
  url: string;
  platform: string;
  source: PageSource;
  /** true only when we saw the target's full name on the page (search text/title or probed HTML). */
  verified_name: boolean;
}

export interface PaidPage {
  url: string;
  platform: string;
  source: Exclude<PageSource, "probe">;
  verified_name: boolean;
}

export interface ProbeBookingResult {
  pages: BookingPage[];
  paid: PaidPage[];
  /** URLs we probed (step d), in order. Empty when probing was not needed. */
  probed: string[];
  /** Non-fatal errors from searches, e.g. "exa error 500". */
  errors: string[];
}

// ---------- helpers (exported for tests) ----------

/** Returns the matching domain from `domains` if `url` is http(s) and its host is that domain or a subdomain of it. */
export function matchDomain(url: string, domains: readonly string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return domains.find((d) => host === d || host.endsWith(`.${d}`));
}

/** Booking-domain match that also rejects the platforms' own marketing pages. */
export function bookingPlatform(url: string): string | undefined {
  const platform = matchDomain(url, BOOKING_DOMAINS);
  if (!platform) return undefined;
  const u = new URL(url);
  const segs = u.pathname.split("/").filter(Boolean);
  if (platform === "calendar.google.com") {
    // Only appointment-schedule pages, not arbitrary calendar links.
    return segs.includes("appointments") ? platform : undefined;
  }
  if (platform === "calendar.app.google") return segs.length ? platform : undefined;
  const first = (segs[0] ?? "").toLowerCase();
  if (RESERVED_SEGMENTS.has(first)) return undefined;
  return platform;
}

export function paidPlatform(url: string): string | undefined {
  const platform = matchDomain(url, PAID_DOMAINS);
  if (!platform) return undefined;
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  const first = (segs[0] ?? "").toLowerCase();
  if (RESERVED_SEGMENTS.has(first)) return undefined;
  return platform;
}

const SPECIAL_CHARS: Record<string, string> = {
  ß: "ss", ø: "o", Ø: "o", æ: "ae", Æ: "ae", œ: "oe", Œ: "oe", ł: "l", Ł: "l", đ: "d", Đ: "d", ð: "d", þ: "th", ı: "i",
};

/** Lowercase ASCII fold: strips accents, maps a few letters NFKD does not decompose. */
export function asciiFold(s: string): string {
  return s
    .replace(/[ßøØæÆœŒłŁđĐðþı]/g, (c) => SPECIAL_CHARS[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** URL slug: lowercase ASCII, accents stripped, apostrophes dropped, other non-alphanumerics -> "-". */
export function slugify(s: string): string {
  return asciiFold(s)
    .replace(/['’‘`ʼ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "dr", "mr", "mrs", "ms"]);

/** Splits a display name into first/last slug tokens, ignoring honorifics/suffixes like "Jr." or "Dr.". */
export function nameParts(name: string): { first?: string; last?: string } {
  const tokens = name
    .split(/\s+/)
    .map((t) => slugify(t))
    .filter((t) => t && !NAME_SUFFIXES.has(t.replace(/-/g, "")));
  if (!tokens.length) return {};
  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;
  return { first, last };
}

/** Candidate probe URLs in priority order, deduped, at most MAX_PROBES. */
export function probeCandidates(name: string): string[] {
  const { first, last } = nameParts(name);
  if (!first) return [];
  const out: string[] = [];
  const add = (u: string) => {
    if (!out.includes(u)) out.push(u);
  };
  const firstLast = last ? `${first}-${last}` : undefined;
  const firstlast = last ? `${first}${last}`.replace(/-/g, "") : undefined;
  if (firstLast) add(`https://calendly.com/${firstLast}`);
  if (firstlast) add(`https://calendly.com/${firstlast}`);
  add(`https://calendly.com/${first}`);
  if (firstLast) add(`https://cal.com/${firstLast}`);
  if (firstlast) add(`https://cal.com/${firstlast}`);
  return out.slice(0, MAX_PROBES);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function normText(s: string): string {
  return asciiFold(decodeEntities(s)).replace(/[’‘`ʼ]/g, "'").replace(/\s+/g, " ");
}

/** True when `text` contains the target's full name (or an alias), case/accent-insensitive, whole-word. */
export function containsName(text: string | null | undefined, target: Target): boolean {
  if (!text) return false;
  const hay = normText(text);
  const names = [target.name, ...(target.aliases ?? [])].map((n) => normText(n).trim()).filter((n) => n.includes(" "));
  return names.some((n) => {
    const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
    return re.test(hay);
  });
}

/** Canonical form for dedupe: lowercase host, no hash, no trailing slash. */
function canon(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  return u.toString().replace(/\/$/, "");
}

function resultMentions(r: ExaResult, target: Target): boolean {
  return containsName(r.title, target) || containsName(r.text, target) || (r.highlights ?? []).some((h) => containsName(h, target));
}

// ---------- probing ----------

async function probeOne(url: string, target: Target, ctx: ToolContext): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const onOuterAbort = () => ac.abort();
  ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await ctx.fetch(url, {
      method: "GET",
      headers: { accept: "text/html" },
      redirect: "follow",
      signal: ac.signal,
    });
    if (res.status !== 200) return false;
    // A redirect off the booking platform (or to its marketing pages) is not the person's page.
    if (res.url && !bookingPlatform(res.url)) return false;
    const html = await res.text();
    return containsName(html, target);
  } catch {
    return false; // network error, timeout, abort: a single failed probe never fails the tool
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onOuterAbort);
  }
}

// ---------- tool ----------

export async function probe_booking_page(input: ProbeBookingInput, ctx: ToolContext): Promise<ProbeBookingResult> {
  const { target } = input;
  const pages: BookingPage[] = [];
  const paid: PaidPage[] = [];
  const probed: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const confidenceOf = new Map<string, Confidence>();

  const addPage = (p: BookingPage, conf: Confidence) => {
    const key = canon(p.url);
    if (seen.has(key)) return;
    seen.add(key);
    pages.push(p);
    confidenceOf.set(p.url, conf);
  };
  const addPaid = (p: PaidPage, conf: Confidence) => {
    const key = canon(p.url);
    if (seen.has(key)) return;
    seen.add(key);
    paid.push(p);
    confidenceOf.set(p.url, conf);
  };

  // a. bio links
  for (const link of input.bioLinks ?? []) {
    const b = bookingPlatform(link);
    if (b) {
      addPage({ url: link, platform: b, source: "bio", verified_name: false }, "high");
      continue;
    }
    const p = paidPlatform(link);
    if (p) addPaid({ url: link, platform: p, source: "bio", verified_name: false }, "high");
  }

  const search = async (fn: () => Promise<ExaResult[]>): Promise<ExaResult[]> => {
    try {
      return await fn();
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      errors.push(errorNote(e));
      return [];
    }
  };

  // b. booking-domain search
  const bookingHits = await search(() =>
    exaSearch(
      {
        query: `${target.name} book a meeting`,
        includeDomains: [...BOOKING_DOMAINS],
        numResults: 10,
        text: { maxCharacters: 2000 },
      },
      ctx,
    ),
  );
  for (const r of bookingHits) {
    const b = bookingPlatform(r.url);
    if (!b) continue;
    // A search hit is kept only if it names the target: the booking-domain search matches any
    // page with a similar first name (live run: 10 pages for other "Boris"es and directory pages).
    if (!resultMentions(r, target)) continue;
    addPage({ url: r.url, platform: b, source: "search", verified_name: true }, "medium");
  }

  // c. paid/mentor platforms
  const paidHits = await search(() =>
    exaSearch(
      {
        query: target.name,
        includeDomains: [...PAID_DOMAINS],
        numResults: 10,
        text: { maxCharacters: 2000 },
      },
      ctx,
    ),
  );
  for (const r of paidHits) {
    const p = paidPlatform(r.url);
    if (!p) continue;
    if (!resultMentions(r, target)) continue; // same reason as above
    addPaid({ url: r.url, platform: p, source: "search", verified_name: true }, "medium");
  }

  // d. guess URL patterns only when nothing trustworthy was found.
  // Unverified search hits (page text never named the target) do not count as "found".
  const trusted = pages.some((p) => p.source === "bio" || p.verified_name);
  if (!trusted) {
    for (const url of probeCandidates(target.name)) {
      if (ctx.signal?.aborted) break;
      probed.push(url);
      if (await probeOne(url, target, ctx)) {
        const platform = bookingPlatform(url) ?? new URL(url).hostname;
        // The same URL may already be listed as an unverified search hit: upgrade it rather than drop the proof.
        const existing = pages.find((p) => canon(p.url) === canon(url));
        if (existing) {
          existing.verified_name = true;
          confidenceOf.set(existing.url, "medium");
        } else {
          addPage({ url, platform, source: "probe", verified_name: true }, "medium");
        }
        break;
      }
    }
  }

  // findings
  for (const p of pages) {
    ctx.findings.save({
      step: "step2",
      tool: TOOL,
      kind: "booking_page",
      claim: `${target.name} has a public booking page on ${p.platform} (${sourceText(p.source)}).`,
      source_url: p.url,
      confidence: confidenceOf.get(p.url) ?? "low",
      data: { platform: p.platform, source: p.source, verified_name: p.verified_name },
    });
  }
  for (const p of paid) {
    ctx.findings.save({
      step: "step2",
      tool: TOOL,
      kind: "paid_consult_page",
      claim: `${target.name} appears to offer paid calls on ${p.platform} (${sourceText(p.source)}).`,
      source_url: p.url,
      confidence: confidenceOf.get(p.url) ?? "low",
      data: { platform: p.platform, source: p.source, verified_name: p.verified_name },
    });
  }

  return { pages, paid, probed, errors };
}

function sourceText(s: PageSource): string {
  return s === "bio" ? "linked from their bio" : s === "search" ? "found via web search" : "found by checking the URL; page shows their name";
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

export function summarizeProbeBookingPage(r: ProbeBookingResult): string {
  const strong = r.pages.filter((p) => p.source !== "search" || p.verified_name);
  const paidStrong = r.paid.filter((p) => p.source === "bio" || p.verified_name);
  const parts: string[] = [];
  if (strong.length) {
    const p = strong[0]!;
    const from = p.source === "bio" ? "from bio" : p.source === "search" ? "from search" : "URL guess, name on page";
    parts.push(`found ${shortUrl(p.url)} (${from})${strong.length > 1 ? ` +${strong.length - 1} more` : ""}`);
  } else if (r.pages.length) {
    parts.push(`no confirmed booking page; ${r.pages.length} unconfirmed hit${r.pages.length > 1 ? "s" : ""}`);
  } else {
    parts.push("no public booking page");
  }
  if (paidStrong.length) parts.push(`paid: ${shortUrl(paidStrong[0]!.url)}`);
  if (r.errors.length) parts.push(`search issue: ${r.errors[0]}`);
  return parts.join("; ");
}
