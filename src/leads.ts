// Live action cards: the moment research saves a finding that opens a path to the person, we turn it
// into a provisional action and emit it, instead of making the user wait for Step 5's ranking.
// Step 5 still runs at the end and re-ranks (and adds drafts); its list replaces these cards by type+url.
//
// The % here is deliberately conservative: the low end of the base-rate range for the action type
// (the same table plan/scoring.py uses), with no boosts, because nothing has been weighed yet.
import type { Finding } from "./core/types.js";

export type LeadType = "referral" | "booking_page" | "event" | "cold_email" | "cold_dm" | "paid_consult" | "network_first" | "post_and_mention";

/** Low end of plan/scoring.py BASE_RANGE: provisional, before any multiplier. */
const BASE_LOW: Record<LeadType, number> = {
  referral: 0.3, booking_page: 0.4, event: 0.1, cold_email: 0.01, cold_dm: 0.01, paid_consult: 0.6, network_first: 0.05, post_and_mention: 0.01,
};

export interface LiveAction {
  id: string;
  type: LeadType;
  title: string;
  how: string[];
  channel_url: string;
  p: number;
  cost_jpy: number;
  hours: number;
  days_to_outcome: number;
  reasons: Record<string, string>;
  evidence: string[];
  provisional: true;
  in_total: true;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Returns the actions one finding opens up (often none). Pure: the caller dedupes and emits. */
export function actionsFromFinding(f: Finding, targetName: string): Omit<LiveAction, "id" | "provisional" | "in_total">[] {
  const first = targetName.split(/\s+/)[0] || targetName;
  const d = (f.data ?? {}) as Record<string, unknown>;
  const mk = (type: LeadType, title: string, how: string[], url: string, cost: number, hours: number, days: number, why: string) => ({
    type, title, how, channel_url: url, p: BASE_LOW[type], cost_jpy: cost, hours, days_to_outcome: days,
    reasons: { base_rate: `${why} (provisional: lowest typical rate for this route, not yet weighed)` }, evidence: [f.id],
  });
  switch (f.kind) {
    case "mutuals": {
      const names = (Array.isArray(d.mutual_connections) ? d.mutual_connections : []).filter((x): x is string => typeof x === "string" && !!x.trim());
      return names.slice(0, 3).map((m) => mk("referral", `Ask ${m} for an intro to ${first}`,
        [`Check how well ${m} knows ${first} (shared company, investments, replies)`, `Send ${m} a short note asking for a two-line intro`],
        f.source_url, 0, 0.3, 3, `${m} is a mutual LinkedIn connection`));
    }
    case "inner_circle": {
      const h = typeof d.handle === "string" ? d.handle : "";
      if (!h) return [];
      return [mk("network_first", `Get to know @${h} first: ${first} talks with them often`,
        [`Read @${h}'s recent posts`, `Reply with something useful, then ask for an intro once there is a thread`],
        `https://x.com/${h}`, 0, 1, 5, `${first} replied to @${h} ${d.count ?? "several"} times recently`)];
    }
    case "event":
      return [mk("event", `Meet ${first} at ${clip(f.claim.replace(/^.*?"(.*)".*$/, "$1"), 70)}`,
        ["Register (or confirm you're registered)", `Prepare a one-line opener tied to what ${first} is speaking about`, "Find them right after their session"],
        f.source_url, 0, 2, 1, f.claim)];
    case "booking_page":
      return [mk("booking_page", `Book time with ${first} through their booking page`,
        ["Open the page and check for open slots", "Pick the earliest slot and write a one-line agenda"],
        f.source_url, 0, 0.2, 2, f.claim)];
    case "paid_consult_page":
      return [mk("paid_consult", `Book a paid call with ${first}`,
        ["Open the page and check the price and next slot", "Book with a specific question"],
        f.source_url, 0, 0.3, 3, f.claim)];
    case "email":
      return [mk("cold_email", `Email ${first} a short, value-first note`,
        [`Send to ${typeof d.email === "string" ? d.email : "the work address"}`, "Three sentences: who you are, the one thing you offer, one ask"],
        f.source_url, 0, 0.5, 3, f.claim)];
    case "precedent":
      return [mk("network_first", `Learn how someone else reached ${first}`,
        ["Read the write-up", "Message its author and ask what worked"],
        f.source_url, 0, 0.5, 3, f.claim)];
    case "post":
      return [mk("post_and_mention", `Reply to ${first}'s recent post with one concrete point`,
        ["Open the post", "Reply with one specific, useful point (no pitch)"],
        f.source_url, 0, 0.2, 2, f.claim)];
    default:
      return [];
  }
}

/** Dedupes by type+url+title, caps posts and inner-circle cards so the deck stays useful, assigns ids. */
export class LiveActions {
  private seen = new Set<string>();
  private perType = new Map<string, number>();
  private seq = 0;
  readonly list: LiveAction[] = [];
  private static CAP: Partial<Record<LeadType, number>> = { post_and_mention: 2, network_first: 4, referral: 5, event: 4 };

  constructor(private readonly targetName: () => string, private readonly onAction: (a: LiveAction) => void) {}

  consider(f: Finding): void {
    for (const a of actionsFromFinding(f, this.targetName())) {
      const key = `${a.type}|${a.channel_url}|${a.title}`.toLowerCase();
      if (this.seen.has(key)) continue;
      const n = this.perType.get(a.type) ?? 0;
      if (n >= (LiveActions.CAP[a.type] ?? 3)) continue;
      this.seen.add(key);
      this.perType.set(a.type, n + 1);
      const full: LiveAction = { ...a, id: `live${++this.seq}`, provisional: true, in_total: true };
      this.list.push(full);
      this.onAction(full);
    }
  }
}
