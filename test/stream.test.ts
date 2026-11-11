import { describe, it, expect, beforeEach } from "vitest";
import { runResearch } from "../src/pipeline.js";
import { RunBudget, withTimeout, OverBudget } from "../src/core/budget.js";
import { actionsFromFinding, LiveActions, type LiveAction } from "../src/leads.js";
import { FindingStore } from "../src/core/findings.js";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import { fakeFetch, makeCtx } from "./helpers.js";

beforeEach(() => resetExaMcpSession());

describe("time budget", () => {
  it("does not start work for a caller that already cancelled", async () => {
    const ac = new AbortController(); ac.abort(new Error("stop"));
    let started = false;
    await expect(withTimeout(async () => { started = true; }, 1000, ac.signal)).rejects.toThrow("stop");
    expect(started).toBe(false);
  });
  it("aborts the step's signal when its budget runs out", async () => {
    let sig: AbortSignal | undefined;
    await expect(withTimeout((s) => { sig = s; return new Promise(() => {}); }, 20)).rejects.toBeInstanceOf(OverBudget);
    expect(sig?.aborted).toBe(true);
  });
  it("withTimeout gives up on a stalled call and reports it as skipped", async () => {
    await expect(withTimeout(() => new Promise(() => {}), 20)).rejects.toBeInstanceOf(OverBudget);
    await expect(withTimeout(async () => 7, 1000)).resolves.toBe(7);
  });
  it("never gives a step more than what is left of the run", () => {
    let t = 0;
    const b = new RunBudget(10_000, () => t);
    t = 8_000;
    expect(b.capFor(60_000)).toBe(2_000);
    expect(b.capFor(500)).toBe(500);
  });
  it("a hung xAI call no longer holds the run: it finishes inside the budget with X marked skipped", async () => {
    const exa = [{ url: "https://www.linkedin.com/in/borisjabes", title: "Boris Jabes - Partner - Y Combinator | LinkedIn", text: "Boris Jabes is a Partner at Y Combinator." },
      { url: "https://x.com/borisjabes", title: "Boris Jabes (@borisjabes) / X", text: "Partner at YC" }];
    const { fetch } = fakeFetch((url) => {
      if (url.startsWith("https://api.x.ai")) return new Promise(() => {}); // never answers
      if (url.startsWith("https://api.exa.ai")) return { json: { results: exa } };
      return { status: 404, text: "" };
    });
    const { ctx, events } = makeCtx(fetch);
    const t0 = Date.now();
    const r = await runResearch({ name: "Boris Jabes", deadline: "2026-11-20", budget: new RunBudget(1_500) }, ctx);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(events.filter((e) => e.id === "step1.x_profile").at(-1)?.note).toMatch(/time budget/);
    const ids = new Set(events.map((e) => e.id));
    for (const id of ids) expect(events.filter((e) => e.id === id).at(-1)?.status).not.toBe("running");
    expect(r.timing.budget_s).toBe(2);
  }, 10_000);
});

describe("live action cards", () => {
  const f = (kind: string, data: Record<string, unknown> = {}, claim = "c") =>
    ({ id: "f1", step: "step1" as const, tool: "t", kind, claim, source_url: "https://example.com/p", confidence: "high" as const, data });

  it("turns paths into actions and ignores plain facts", () => {
    expect(actionsFromFinding(f("bio"), "Boris Jabes")).toHaveLength(0);
    const m = actionsFromFinding(f("mutuals", { mutual_connections: ["Ann Lee", "Bo Chen", "Cy Wu", "Di Ng"] }), "Boris Jabes");
    expect(m.map((a) => a.title)).toEqual(["Ask Ann Lee for an intro to Boris", "Ask Bo Chen for an intro to Boris", "Ask Cy Wu for an intro to Boris"]);
    expect(m[0]!.type).toBe("referral");
    expect(actionsFromFinding(f("inner_circle", { handle: "gdb", count: 4 }), "Boris Jabes")[0]!.channel_url).toBe("https://x.com/gdb");
    expect(actionsFromFinding(f("booking_page"), "Boris Jabes")[0]!.type).toBe("booking_page");
    expect(m[1]!.contact).toBe("Bo Chen");
  });

  it("only suggests an event when the person hosts, speaks or attends", () => {
    expect(actionsFromFinding(f("event", { role: "unknown" }), "Boris Jabes")).toHaveLength(0);
    expect(actionsFromFinding(f("event", { role: "speaker" }), "Boris Jabes")).toHaveLength(1);
  });

  it("skips a booking page the live check found inactive", () => {
    expect(actionsFromFinding(f("booking_page", { profile_active: false }), "Boris Jabes")).toHaveLength(0);
  });

  it("labels a booking page with no confirmed slots as unverified and caps it at 5%, like Step 5", () => {
    const u = actionsFromFinding(f("booking_page", { profile_active: true, live: false, slots_confirmed: false }), "Boris Jabes")[0]!;
    expect(u.title).toMatch(/\(unverified page\)$/);
    expect(u.p).toBe(0.05);
    const v = actionsFromFinding(f("booking_page", { live: true }), "Boris Jabes")[0]!;
    expect(v.title).not.toMatch(/unverified/);
    expect(v.p).toBe(0.4);
  });

  it("fits an event to the deadline by its date, and leaves an undated event unconfirmed", () => {
    const got: LiveAction[] = [];
    const live = new LiveActions(() => "Boris Jabes", (a) => got.push(a), 1, "2026-11-12");
    live.consider({ ...f("event", { role: "speaker", event_date: "2026-11-12" }, "a"), id: "e1", source_url: "https://lu.ma/a" });
    live.consider({ ...f("event", { role: "speaker", event_date: "2026-11-14" }, "b"), id: "e2", source_url: "https://lu.ma/b" });
    live.consider({ ...f("event", { role: "speaker" }, "c"), id: "e3", source_url: "https://lu.ma/c" });
    expect(got.map((a) => a.in_total)).toEqual([true, false, false]);
  });

  it("leaves an unchecked paid-call price unknown instead of ¥0", () => {
    expect(actionsFromFinding(f("paid_consult_page"), "Boris Jabes")[0]!.cost_jpy).toBeNull();
  });

  it("marks cards that can't land before the deadline, and caps precedents apart from inner-circle contacts", () => {
    const got: LiveAction[] = [];
    const live = new LiveActions(() => "Boris Jabes", (a) => got.push(a), 0); // deadline today
    for (let i = 0; i < 4; i++) live.consider({ ...f("precedent", {}, `p${i}`), id: `f${i}`, source_url: `https://e.com/${i}` });
    live.consider({ ...f("inner_circle", { handle: "gdb", count: 3 }), id: "f9" });
    expect(got.filter((a) => a.from_kind === "precedent")).toHaveLength(1); // same advice from 4 write-ups is one card
    expect(got.some((a) => a.contact === "@gdb")).toBe(true);
    expect(got.every((a) => a.in_total === false)).toBe(true); // 3-5 day routes, deadline today
  });

  it("emits each card the moment its finding is saved, deduped and capped", () => {
    const store = new FindingStore();
    const got: LiveAction[] = [];
    const live = new LiveActions(() => "Boris Jabes", (a) => got.push(a));
    store.onSave((x) => live.consider(x));
    for (let i = 0; i < 5; i++) store.save({ step: "step1", tool: "x_profile", kind: "post", claim: `post ${i}`, source_url: `https://x.com/b/status/${i}`, confidence: "high" });
    expect(got).toHaveLength(1); // five posts give the same advice: one card
    store.save({ step: "step2", tool: "probe_booking_page", kind: "booking_page", claim: "cal", source_url: "https://cal.com/b", confidence: "high" });
    expect(got.at(-1)?.type).toBe("booking_page");
    expect(got.every((a) => a.provisional && /^live\d+$/.test(a.id))).toBe(true);
  });

  it("runResearch streams actions before it returns", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/event_types")) return { json: [{ name: "30 min" }] }; // Calendly API: active profile
      if (url.startsWith("https://calendly.com/api/")) return { json: { name: "Boris Jabes" } };
      if (url.startsWith("https://api.exa.ai")) return { json: { results: [{ url: "https://calendly.com/borisjabes", title: "Boris Jabes | Calendly", text: "Boris Jabes. Book a 30 minute meeting." }] } };
      return { status: 404, text: "" };
    });
    const { ctx } = makeCtx(fetch);
    const seen: LiveAction[] = [];
    const r = await runResearch({ name: "Boris Jabes", deadline: "2026-11-20", onAction: (a) => seen.push(a) }, ctx);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBe(r.live_actions.length);
    expect(seen.some((a) => a.type === "booking_page" && /calendly\.com/.test(a.channel_url))).toBe(true);
  }, 20_000);
});
