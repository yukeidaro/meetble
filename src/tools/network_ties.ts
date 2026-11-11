// Phase 4, network research: how strong is each warm path, and which background do you share?
//
//  - mutual_ties: LinkedIn lists your mutual connections with the target, but a name alone says nothing about how
//    well they know each other. For each mutual (up to 5) we search the web for pages that name both people and
//    read the passage where they appear together: co-founded / worked together > invested / spoke together >
//    merely named together. That ranks "who to ask for the intro".
//  - shared_affiliations: schools, past companies and communities you list in user_profile.json `affiliations`
//    that also show up next to the target's name on the web. A shared background makes an intro or cold note warmer,
//    and the people from it are where to look for a mutual.
import type { Target, ToolContext } from "../core/types.js";
import type { ExaResult } from "./exa.js";
import { clip, fold, mentionsName, nameTokens, searchAll } from "./resolve_target.js";

export type TieStrength = 1 | 2 | 3;
export interface MutualTie { mutual: string; tie: string; strength: TieStrength; url: string; excerpt: string }
export interface MutualTiesResult { ties: MutualTie[]; checked: number; failed_queries: number }

/** Checked in order; the first that matches the passage naming both people wins. */
const TIES: Array<[TieStrength, string, RegExp]> = [
  [3, "co-founded a company together", /\bco-?found(ed|ers?)\b|\bfounded\b.{0,40}\b(with|together)\b/],
  [3, "worked together", /\b(worked (together|with)|colleagues?|co-?workers?|team ?mates?|reported to|his manager|her manager|hired (him|her))\b/],
  [2, "investor and founder", /\b(invest(ed|or|ment)|backed|portfolio|angel|seed round|led the round)\b/],
  [2, "spoke or wrote together", /\b(podcast|interview(ed)?|panel|fireside|keynote|co-?author(ed)?|wrote with|episode|hosted)\b/],
  [2, "board or advisor", /\b(board (member|of directors)|advis(or|er|ory))\b/],
];

/** The passage (±300 chars) around the first place both names appear close together, or undefined. */
export function bothNamed(text: string, a: string, b: string): string | undefined {
  const hay = fold(text);
  const lastA = nameTokens(a).at(-1), lastB = nameTokens(b).at(-1);
  if (!lastA || !lastB || lastA === lastB) return undefined;
  const re = (t: string) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "g");
  const posB = [...hay.matchAll(re(lastB))].map((m) => m.index ?? 0);
  for (const m of hay.matchAll(re(lastA))) {
    const i = m.index ?? 0;
    if (posB.some((j) => Math.abs(j - i) <= 300)) return text.slice(Math.max(0, i - 300), i + 300);
  }
  return undefined;
}

export function classifyTie(passage: string): { strength: TieStrength; tie: string } {
  const p = fold(passage);
  for (const [strength, tie, re] of TIES) if (re.test(p)) return { strength, tie };
  return { strength: 1, tie: "named together online" };
}

const textOf = (r: ExaResult) => [r.title ?? "", r.text ?? "", ...(r.highlights ?? [])].join(" \n ");

export async function mutual_ties(input: { target: Target; mutuals: string[] }, ctx: ToolContext): Promise<MutualTiesResult> {
  const t = input.target;
  const mutuals = [...new Set(input.mutuals.map((m) => m.trim()).filter((m) => nameTokens(m).length >= 2))].slice(0, 5);
  if (!mutuals.length) return { ties: [], checked: 0, failed_queries: 0 };
  const { lists, failed } = await searchAll(mutuals.map((m) => ({
    query: `${m} ${t.name}${t.company ? ` ${t.company}` : ""}`,
    objective: `Pages that mention both ${m} and ${t.name}, and say how they know each other (worked together, co-founded, invested, podcast).`,
    numResults: 5, text: { maxCharacters: 4000 },
  })), ctx);
  const ties: MutualTie[] = [];
  mutuals.forEach((m, i) => {
    let best: MutualTie | undefined;
    for (const r of lists[i] ?? []) {
      const all = textOf(r);
      if (!mentionsName(all, m) || !mentionsName(all, t.name)) continue;
      const passage = bothNamed(all, m, t.name);
      if (!passage) continue;
      const c = classifyTie(passage);
      if (!best || c.strength > best.strength) best = { mutual: m, ...c, url: r.url, excerpt: clip(passage, 280) };
    }
    if (best) {
      ties.push(best);
      ctx.findings.save({ step: "step2", tool: "mutual_ties", kind: "mutual_tie", claim: `${m} and ${t.name}: ${best.tie}. "${best.excerpt}"`,
        source_url: best.url, confidence: best.strength >= 2 ? "high" : "medium", data: { mutual: m, tie: best.tie, strength: best.strength } });
    }
  });
  ties.sort((a, b) => b.strength - a.strength);
  return { ties, checked: mutuals.length, failed_queries: failed };
}

export function summarizeMutualTies(r: MutualTiesResult): string {
  if (!r.checked) return "no mutual connections to check";
  if (!r.ties.length) return `checked ${r.checked} mutuals: none named with them online`;
  return `${r.ties.length} of ${r.checked} mutuals know them: ${r.ties.slice(0, 3).map((x) => `${x.mutual} (${x.tie})`).join(", ")}`;
}

export interface SharedAffiliation { affiliation: string; url: string; excerpt: string }
export interface SharedAffiliationsResult { shared: SharedAffiliation[]; checked: number; failed_queries: number }

/** `affiliations` comes from user_profile.json: schools, past companies, communities, cities. */
export async function shared_affiliations(input: { target: Target; affiliations: string[] }, ctx: ToolContext): Promise<SharedAffiliationsResult> {
  const t = input.target;
  const affs = [...new Set(input.affiliations.map((a) => a.trim()).filter((a) => a.length >= 2))].slice(0, 6);
  if (!affs.length) return { shared: [], checked: 0, failed_queries: 0 };
  const { lists, failed } = await searchAll(affs.map((a) => ({
    query: `${t.name} ${a}`,
    objective: `Pages showing that ${t.name} studied at, worked at, or belongs to ${a}.`,
    numResults: 5, text: { maxCharacters: 3000 },
  })), ctx);
  const shared: SharedAffiliation[] = [];
  affs.forEach((a, i) => {
    const re = new RegExp(`(^|[^a-z0-9])${fold(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    for (const r of lists[i] ?? []) {
      const all = textOf(r);
      if (!mentionsName(all, t.name) || !re.test(fold(all))) continue;
      const passage = bothNamed(all, t.name, a) ?? all.slice(0, 400);
      shared.push({ affiliation: a, url: r.url, excerpt: clip(passage, 240) });
      ctx.findings.save({ step: "step2", tool: "shared_affiliations", kind: "shared_affiliation", claim: `You and ${t.name} share ${a}. "${clip(passage, 200)}"`,
        source_url: r.url, confidence: "medium", data: { affiliation: a } });
      break;
    }
  });
  return { shared, checked: affs.length, failed_queries: failed };
}

export function summarizeSharedAffiliations(r: SharedAffiliationsResult): string {
  if (!r.checked) return "no affiliations in user_profile.json";
  return r.shared.length ? `shared: ${r.shared.map((s) => s.affiliation).join(", ")}` : `none of your ${r.checked} affiliations found with them`;
}
