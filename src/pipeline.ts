// Steps 0-2 of Meetble: resolve who, research what they want, find what they're doing now.
// Every tool runs inside runStep, so one failure becomes a ❌/⏭️ checklist line and never stops the run.
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
import { probe_booking_page, summarizeProbeBookingPage } from "./tools/probe_booking_page.js";

export interface ResearchInput {
  name: string;
  hint?: string;
  deadline: string;                 // YYYY-MM-DD
  offerInventory?: unknown[];       // from user_profile.json, passed through for Steps 3-5
  targetOverrides?: Partial<Target>; // e.g. known x_handle, to skip guessing
  eventUrls?: string[];             // events the user attends (CLI --event-url / profile my_events)
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

export async function runResearch(input: ResearchInput, ctx: ToolContext) {
  const first = input.name.split(/\s+/)[0] ?? input.name;

  // STEP 0
  const resolved = await runStep(ctx, "step0.resolve_target", `Identifying ${input.name}`,
    () => resolve_target({ name: input.name, hint: input.hint }, ctx), summarizeResolveTarget);
  const target: Target = { ...(resolved?.target ?? { name: input.name }), ...stripUndefined(input.targetOverrides ?? {}) };
  if (!target.x_handle) {
    const xh = await runStep(ctx, "step0.find_x_handle", `Finding ${input.name}'s X account`,
      () => findXHandle({ target }, ctx), summarizeFindXHandle);
    if (xh?.handle) target.x_handle = xh.handle;
  }

  // STEP 1 (parallel)
  const [web, pods, prec, xp, ig, email, li] = await Promise.all([
    runStep(ctx, "step1.search_web", `Reading ${first}'s bio, interviews and essays`, () => search_web({ target }, ctx), summarizeSearchWeb),
    runStep(ctx, "step1.podcast_quotes", `Finding ${first}'s podcasts and talks`, () => podcast_quotes({ target }, ctx), summarizePodcastQuotes),
    runStep(ctx, "step1.find_precedents", `Finding people who already reached ${first}`, () => find_precedents({ target }, ctx), summarizeFindPrecedents),
    runStep(ctx, "step1.x_profile", `Reading ${first}'s recent X posts`, () => xProfile({ target }, ctx), summarizeXProfile),
    runStep(ctx, "step1.instagram_public", `Checking ${first}'s public Instagram`, () => instagramPublic({ target }, ctx), summarizeInstagramPublic),
    runStep(ctx, "step1.guess_work_email", `Estimating ${first}'s work email`, () => guess_work_email({ target }, ctx), summarizeGuessWorkEmail),
    runStep(ctx, "step1.linkedin_profile", `Opening ${first}'s LinkedIn in your Chrome`, () => linkedinProfile({ target }, ctx), summarizeLinkedInProfile),
  ]);

  // STEP 2 (parallel)
  const bioLinks = [target.website, target.linkedin_url].filter((u): u is string => typeof u === "string");
  const [webMentions, xMentions, events, booking] = await Promise.all([
    runStep(ctx, "step2.recent_web_mentions", `Checking news about ${first} this week`, () => recent_web_mentions({ target }, ctx), summarizeRecentWebMentions),
    runStep(ctx, "step2.recent_x_mentions", `Checking X posts by and about ${first} this week`, () => recentXMentions({ target }, ctx), summarizeRecentXMentions),
    runStep(ctx, "step2.find_events", `Finding events ${first} joins before ${input.deadline}`, () => find_events({ target, deadline: input.deadline, eventUrls: input.eventUrls }, ctx), summarizeFindEvents),
    runStep(ctx, "step2.probe_booking_page", `Looking for ${first}'s booking page`, () => probe_booking_page({ target, bioLinks }, ctx), summarizeProbeBookingPage),
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
    summary: {
      counts_by_dimension: countBy(findings.map((f) => f.dimension)),
      x_profile: xp ?? null,
      linkedin: li?.data ?? null,
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
