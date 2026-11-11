// Shared types for Meetble research (Steps 0-2). Every tool takes (input, ctx) and returns a typed result.

export type StepStatus = "running" | "done" | "error" | "skipped";

/** One checklist line in the UI: icon + label + (note). */
export interface StepEvent {
  id: string;          // stable id, e.g. "step1.x_profile"
  label: string;       // what is being done, e.g. "Reading Boris's recent X posts"
  status: StepStatus;
  note?: string;       // one-line result, shown in parentheses. Always set when status != running.
  at: string;          // ISO time
}

export type Confidence = "high" | "medium" | "low";

/** A fact the agent found. Every finding must carry a real http(s) source URL. */
export interface Finding {
  id: string;            // assigned by FindingStore, e.g. "f12"
  step: "step0" | "step1" | "step2";
  tool: string;          // tool name, e.g. "podcast_quotes"
  kind: string;          // e.g. "bio", "quote", "event", "post", "booking_page", "email", "precedent", "mention"
  claim: string;         // one-sentence fact in plain English
  source_url: string;    // required, http(s)
  quote?: string;        // verbatim words, when the source has them
  date?: string;         // ISO date of the source, when known
  confidence: Confidence;
  data?: Record<string, unknown>; // tool-specific structured extras
}

export type NewFinding = Omit<Finding, "id">;

/** The person we are trying to reach, resolved in Step 0. */
export interface Target {
  name: string;
  company?: string;
  role?: string;
  company_domain?: string;   // e.g. "ycombinator.com"
  x_handle?: string;         // without "@"
  linkedin_url?: string;
  instagram_handle?: string;
  website?: string;
  aliases?: string[];
}

export interface Env {
  EXA_API_KEY?: string;
  XAI_API_KEY?: string;
  MODEL_API_KEY?: string;      // Meta Model API (Muse Spark)
  ANTHROPIC_API_KEY?: string;
  HUNTER_API_KEY?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Everything a tool may touch. Tests inject a fake fetch and a fixed clock. */
export interface ToolContext {
  fetch: FetchLike;
  env: Env;
  now: () => Date;
  emit: (e: StepEvent) => void;
  findings: import("./findings.js").FindingStore;
  signal?: AbortSignal;
}
