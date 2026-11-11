// Steps 0-2 of Meetble: resolve who, research what they want, find what they're doing now.
// Every tool runs inside runStep under a time budget, so one failure or stall becomes a ❌/⏭️ checklist line
// and never stops the run.
import { runStep } from "./core/step.js";
import type { Finding, Target, ToolContext } from "./core/types.js";
import { resolve_target, summarizeResolveTarget } from "./tools/resolve_target.js";
import { search_web, summarizeSearchWeb } from "./tools/search_web.js";
import { findXHandle, summarizeFindXHandle } from "./tools/find_x_handle.js";
import { linkedinProfile, summarizeLinkedInProfile } from "./tools/linkedin_profile.js";
import { podcast_quotes, summarizePodcastQuotes } from "./tools/podcast_quotes.js";
import { find_precedents, summarizeFindPrecedents } from "./tools/find_precedents.js";
import { xProfile, summarizeXProfile } from "./tools/x_profile.js";
import { instagramPublic, summarizeInstagramPublic } from "./tools/instagram_public.js";
import { guess_work_email, summarizeGuessWorkEmail } from "./tools/guess_work_email.js";
import { recent_web_mentions, summarizeRecentWebMentions } from "./tools/recent_web_mentions.js";
import { recentXMentions, summarizeRecentXMentions } from "./tools/recent_x_mentions.js";
import { find_events, summarizeFindEvents } from "./tools/find_events.js";
import { loginCheck, lumaMyEvents, summarizeLoginCheck, summarizeLumaMyEvents, type LoginCheckResult } from "./tools/browser_session.js";
import { probe_booking_page, summarizeProbeBookingPage } from "./tools/probe_booking_page.js";
import { RunBudget, withTimeout } from "./core/budget.js";
import { LiveActions, type LiveAction } from "./leads.js";

export interface ResearchInput {
  name: string;
  hint?: string;
  deadline: string;                 // YYYY-MM-DD
  offerInventory?: unknown[];       // from user_profile.json, passed through for Steps 3-5
  targetOverrides?: Partial<Target>; // e.g. known x_handle, to skip guessing
  eventUrls?: string[];             // events the user attends (CLI --event-url / profile my_events)
  /** Called when the pre-flight check finds sites signed out: ask the human to log in, resolve true to re-check. */
  waitForLogin?: (check: LoginCheckResult) => Promise<boolean>;
  /** Called as soon as a finding opens a path to the person (a live, provisional action card). */
  onAction?: (a: LiveAction) => void;
  /** Run-wide time budget (default MEETBLE_BUDGET_S, 300 s). */
  budget?: RunBudget;
}

/** Maps a tool to the "dimension" the Steps 3-5 code groups findings by. */
const DIMENSION: Record<string, string> = {
  resolve_target: "web", find_x_handle: "x", search_web: "web", podcast_quotes: "podcast", find_precedents: "precedent",
  x_profile: "x", linkedin_profile: "linkedin", instagram_public: "instagram", guess_work_email: "email",
  recent_web_mentions: "mention", recent_x_mentions: "mention", find_events: "event", probe_booking_page: "booking",
};

export function dimensionOf(f: Finding): string {
  if (f.tool === "recent_x_mentions") return "x";
  if (/linkedin\.com\//i.test(f.source_url)) return "linkedin";
  return DIMENSION[f.tool] ?? "web";
}

/** "Visiting Partner at Y Combinator" / "Partner @ Y Combinator" / "Partner, Y Combinator" → "Y Combinator". */
export function companyFromRole(role?: string): string | undefined {
  if (!role) return undefined;
  const m = role.match(/(?:\bat\b|@|,)\s*([^|·•,()]+?)\s*(?:$|[|·•,(])/i);
  const c = m?.[1]?.trim();
  return c && c.length >= 2 && c.length <= 60 ? c : undefined;
}

/** Per-step caps (ms). The run-wide budget can cut them shorter; see core/budget.ts. */
export const STEP_CAP_MS: Record<string, number> = {
  login_check: 180_000, luma_my_events: 150_000, resolve_target: 60_000, find_x_handle: 60_000,
  search_web: 90_000, podcast_quotes: 90_000, find_precedents: 90_000, x_profile: 150_000, instagram_public: 90_000,
  guess_work_email: 90_000, linkedin_profile: 180_000, recent_web_mentions: 60_000, recent_x_mentions: 120_000,
  find_events: 120_000, probe_booking_page: 60_000,
};

export function runBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number(env.MEETBLE_BUDGET_S);
  return (Number.isFinite(s) && s >= 30 ? s : 300) * 1000;
}

/**
 * Steps 0-2 as one dependency graph instead of three gated stages (root cause #1 in the redesign doc):
 * every tool starts as soon as what it needs is known, so the slowest tool no longer holds back the rest.
 *  - The sign-in check runs in the background; only the Luma event lookup waits for it.
 *  - X tools wait for the X handle; find_events waits for your Luma events; the email guess waits for the company.
 *  - Everything else starts right after the person is identified.
 * Every step also runs under the run-wide time budget, and findings that open a path to the person become
 * live action cards immediately (input.onAction) instead of waiting for Step 5.
 */
export async function runResearch(input: ResearchInput, ctx: ToolContext) {
  const first = input.name.split(/\s+/)[0] ?? input.name;
  const budget = input.budget ?? new RunBudget(runBudgetMs());
  const step = <T>(id: string, label: string, fn: () => Promise<T>, summarize: (r: T) => string) => {
    const tool = id.replace(/^step\d\./, "").replace(/_recheck$/, "");
    return runStep(ctx, id, label, () => withTimeout(fn, budget.capFor(STEP_CAP_MS[tool] ?? 90_000)), summarize);
  };

  let targetName = input.name;
  const live = new LiveActions(() => targetName, (a) => input.onAction?.(a));
  ctx.findings.onSave((f) => live.consider(f));

  // STEP 0, in the background: sign-in check, then your Luma events.
  const loginP = (async () => {
    let login = await step("step0.login_check", "Checking you're signed in to Luma, LinkedIn, X and Instagram", () => loginCheck({}, ctx), summarizeLoginCheck);
    if (login && !login.skipped && (login.signed_out?.length || login.account_mismatch) && input.waitForLogin && (await input.waitForLogin(login))) {
      login = await step("step0.login_recheck", "Re-checking sign-ins", () => loginCheck({}, ctx), summarizeLoginCheck);
    }
    return login;
  })();
  const mineP = loginP.then((login) => login?.sites?.luma?.logged_in === true
    ? step("step0.luma_my_events", "Reading your upcoming Luma events", () => lumaMyEvents({}, ctx), summarizeLumaMyEvents)
    : undefined);

  const resolved = await step("step0.resolve_target", `Identifying ${input.name}`,
    () => resolve_target({ name: input.name, hint: input.hint }, ctx), summarizeResolveTarget);
  const target: Target = { ...(resolved?.target ?? { name: input.name }), ...stripUndefined(input.targetOverrides ?? {}) };
  targetName = target.name || input.name;

  const xHandleP = target.x_handle
    ? Promise.resolve()
    : step("step0.find_x_handle", `Finding ${input.name}'s X account`, () => findXHandle({ target }, ctx), summarizeFindXHandle)
        .then((xh) => { if (xh?.handle) target.x_handle = xh.handle; });

  // STEP 1 + 2: start everything that only needs the identified person.
  const liP = step("step1.linkedin_profile", `Opening ${first}'s LinkedIn in your Chrome`, () => linkedinProfile({ target }, ctx), summarizeLinkedInProfile);
  const webP = step("step1.search_web", `Reading ${first}'s bio, interviews and essays`, () => search_web({ target }, ctx), summarizeSearchWeb);
  const podsP = step("step1.podcast_quotes", `Finding ${first}'s podcasts and talks`, () => podcast_quotes({ target }, ctx), summarizePodcastQuotes);
  const precP = step("step1.find_precedents", `Finding people who already reached ${first}`, () => find_precedents({ target }, ctx), summarizeFindPrecedents);
  const igP = step("step1.instagram_public", `Checking ${first}'s public Instagram`, () => instagramPublic({ target }, ctx), summarizeInstagramPublic);
  const webMentionsP = step("step2.recent_web_mentions", `Checking news about ${first} this week`, () => recent_web_mentions({ target }, ctx), summarizeRecentWebMentions);
  const bioLinks = [target.website, target.linkedin_url].filter((u): u is string => typeof u === "string");
  const bookingP = step("step2.probe_booking_page", `Looking for ${first}'s booking page`, () => probe_booking_page({ target, bioLinks }, ctx), summarizeProbeBookingPage);

  // Needs the X handle.
  const xpP = xHandleP.then(() => step("step1.x_profile", `Reading ${first}'s recent X posts`, () => xProfile({ target }, ctx), summarizeXProfile));
  const xMentionsP = xHandleP.then(() => step("step2.recent_x_mentions", `Checking X posts by and about ${first} this week`, () => recentXMentions({ target }, ctx), summarizeRecentXMentions));

  // Needs your Luma events (or gives up on them when the sign-in check is skipped or over budget).
  let eventUrls: string[] = [...(input.eventUrls ?? [])];
  const eventsP = mineP.then((mine) => {
    eventUrls = [...eventUrls, ...(mine?.events ?? []).map((e) => e.url)];
    return step("step2.find_events", `Finding events ${first} joins before ${input.deadline}`, () => find_events({ target, deadline: input.deadline, eventUrls }, ctx), summarizeFindEvents);
  });

  // Needs the company: known now, or read from LinkedIn (this used to race; now it's a dependency).
  const emailP = (target.company ? Promise.resolve() : liP.then((li) => {
    const c = companyFromRole(li?.data?.current_role) ?? companyFromRole(li?.data?.headline);
    if (!target.company && c) target.company = c;
  })).then(() => step("step1.guess_work_email", `Estimating ${first}'s work email${target.company ? ` (${target.company})` : ""}`, () => guess_work_email({ target }, ctx), summarizeGuessWorkEmail));

  const [login, mine, web, pods, prec, xp, ig, email, li, webMentions, xMentions, events, booking] = await Promise.all([
    loginP, mineP, webP, podsP, precP, xpP, igP, emailP, liP, webMentionsP, xMentionsP, eventsP, bookingP,
  ]);

  const findings = ctx.findings.all().map((f) => ({
    ...f,
    step: f.step === "step2" ? 2 : f.step === "step1" ? 1 : 0,
    dimension: dimensionOf(f),
  }));

  return {
    goal: { target_name: input.name, deadline: input.deadline, meet: "reply, call or in-person meeting" },
    target_id: target,
    ambiguous_target: resolved?.ambiguous ?? false,
    candidates: resolved?.candidates ?? [],
    offer_inventory: input.offerInventory ?? [],
    findings,
    booking_pages: booking ? [...booking.pages, ...booking.paid] : [],
    events: events?.events ?? [],
    email_guess: email ?? null,
    live_actions: live.list,
    timing: { elapsed_s: budget.elapsedS(), budget_s: Math.round(budget.totalMs / 1000) },
    summary: {
      counts_by_dimension: countBy(findings.map((f) => f.dimension)),
      x_profile: xp ?? null,
      linkedin: li?.data ?? null,
      logins: login?.sites ?? null,
      my_events: mine?.events ?? [],
      instagram: ig ?? null,
      web: web ? { count: ctx.findings.byTool("search_web").length } : null,
      podcasts: pods ? { count: ctx.findings.byTool("podcast_quotes").length } : null,
      precedents: prec ? { count: ctx.findings.byTool("find_precedents").length } : null,
      mentions: { web: webMentions ?? null, x: xMentions ?? null },
    },
  };
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}
