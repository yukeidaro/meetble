import { requestJson, requireKey } from "../core/http.js";
import { isHttpUrl } from "../core/findings.js";
import type { Target, ToolContext } from "../core/types.js";
import { parseJsonLoose, parseResponsesOutput } from "./xai.js";

// Step 1 (optional): the target's PUBLIC, PROFESSIONAL Instagram presence, via Meta Model API (Muse Spark) + web_search.
// Docs: https://dev.meta.ai/resources/blog/build-with-muse-spark
//       https://dev.meta.ai/docs/overview            (base URL, Bearer MODEL_API_KEY, model ids)
//       https://dev.meta.ai/docs/search-grounding    (tools:[{type:"web_search"}], output[].content[].annotations url_citation)
// Model id: the overview lists muse-spark-1.1, 1.2 and 1.3; we pin 1.1 as specified by the team. Change it here only.

export const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
export const META_MODEL = "muse-spark-1.1";
const TOOL = "instagram_public";

export interface InstagramTopic { topic: string; url: string }
export interface InstagramPublicResult {
  account?: { handle: string; url: string; bio?: string };
  topics: InstagramTopic[];
  citations: string[];
  rawText?: string;
}

const IG_HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "about", "developer", "legal", "directory"]);

export function normalizeIgHandle(h: unknown): string {
  if (typeof h !== "string") return "";
  let s = h.trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#\s]+)/i);
  if (m) s = m[1] ?? "";
  s = s.replace(/^@+/, "").trim();
  return IG_HANDLE_RE.test(s) && !IG_RESERVED.has(s.toLowerCase()) ? s : "";
}

/** Canonical key for comparing URLs: lowercase host without www, path without trailing slash, no query/hash. */
function urlKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "").toLowerCase()}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

export function buildInstagramPrompt(target: Target): string {
  const who = [target.name, target.role, target.company].filter(Boolean).join(", ");
  const hint = normalizeIgHandle(target.instagram_handle);
  return [
    `Use web search to find the PUBLIC, PROFESSIONAL Instagram presence of ${who}.`,
    hint ? `Their Instagram handle may be @${hint}; verify it.` : "",
    `Report only: the account handle, its public bio, and recurring PUBLIC professional topics they post about (work, talks, companies, products, industry events).`,
    `Do NOT report family members, children, home or current locations, travel, or who they are with. If unsure an account is theirs, return null for account.`,
    `Respond with STRICT JSON only, no prose and no markdown fences:`,
    `{"account":{"handle":"without_at","url":"https://www.instagram.com/<handle>/","bio":"..."} | null, "topics":[{"topic":"short label","source_url":"exact URL of the page you read"}]}`,
    `Every URL must be a page you actually retrieved. Never invent URLs; omit items you cannot source.`,
  ].filter(Boolean).join("\n");
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function instagramPublic(input: { target: Target }, ctx: ToolContext): Promise<InstagramPublicResult> {
  const key = requireKey(ctx.env, "MODEL_API_KEY");
  const { target } = input;
  if (!target?.name?.trim()) throw new Error("instagram_public: target.name is required");

  const r = await requestJson<unknown>({
    service: "meta",
    url: META_RESPONSES_URL,
    headers: { authorization: `Bearer ${key}` },
    body: { model: META_MODEL, input: buildInstagramPrompt(target), tools: [{ type: "web_search" }] },
    fetch: ctx.fetch,
    signal: ctx.signal,
    timeoutMs: 120_000,
    retries: 1,             // 429/5xx/connection errors only
    retryOnTimeout: false,  // a timed-out agentic search already ran (and was billed) server-side
  });
  const { text, urls } = parseResponsesOutput(r);
  const citations = urls.filter(isHttpUrl);
  const cited = new Map(citations.map((u) => [urlKey(u), u] as const));
  const json = parseJsonLoose(text);
  const data = asObj(json);
  const result: InstagramPublicResult = { topics: [], citations };
  if (json === null || Array.isArray(json)) result.rawText = text;

  // Account: the handle must be valid and its source must be a cited instagram.com URL for that handle.
  const acc = asObj(data.account);
  const handle = normalizeIgHandle(acc.handle) || normalizeIgHandle(acc.url);
  if (handle) {
    const fromModel = typeof acc.url === "string" ? cited.get(urlKey(acc.url)) : undefined;
    const sourceUrl = fromModel && normalizeIgHandle(fromModel).toLowerCase() === handle.toLowerCase()
      ? fromModel
      : citations.find((u) => /(^|\.)instagram\.com$/i.test(safeHost(u)) && normalizeIgHandle(u).toLowerCase() === handle.toLowerCase());
    if (sourceUrl) {
      const bio = typeof acc.bio === "string" && acc.bio.trim() ? acc.bio.trim() : undefined;
      result.account = { handle, url: sourceUrl, bio };
      ctx.findings.save({
        step: "step1",
        tool: TOOL,
        kind: "instagram",
        claim: `${target.name}'s public Instagram is @${handle}${bio ? `; bio: "${bio}"` : ""}`,
        source_url: sourceUrl,
        quote: bio,
        confidence: "medium",
        data: { handle, bio },
      });
    }
  }

  // Topics: only those whose source_url was actually cited by the search.
  const seen = new Set<string>();
  for (const raw of asArray(data.topics)) {
    const t = asObj(raw);
    const topic = typeof t.topic === "string" ? t.topic.trim() : "";
    const url = typeof t.source_url === "string" ? cited.get(urlKey(t.source_url)) : undefined;
    if (!topic || !url || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    result.topics.push({ topic, url });
    ctx.findings.save({
      step: "step1",
      tool: TOOL,
      kind: "instagram",
      claim: `${target.name} posts publicly on Instagram about ${topic}`,
      source_url: url,
      confidence: "low",
      data: { topic, handle: result.account?.handle },
    });
  }
  return result;
}

function safeHost(u: string): string {
  try { return new URL(u).hostname; } catch { return ""; }
}

export function summarizeInstagramPublic(r: InstagramPublicResult): string {
  if (r.rawText !== undefined && !r.account && r.topics.length === 0) return "answer was not valid JSON; nothing saved";
  if (!r.account && r.topics.length === 0) return "no public Instagram found";
  const parts: string[] = [];
  if (r.account) parts.push(`@${r.account.handle}`);
  parts.push(`${r.topics.length} topic${r.topics.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}
