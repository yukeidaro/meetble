import { describe, it, expect, beforeEach } from "vitest";
import { resetExaMcpSession } from "../src/tools/exa_mcp.js";
import {
  bookingPlatform,
  containsName,
  matchDomain,
  paidPlatform,
  probeCandidates,
  probe_booking_page,
  slugify,
  summarizeProbeBookingPage,
  BOOKING_DOMAINS,
  PAID_DOMAINS,
} from "../src/tools/probe_booking_page.js";
import { fakeFetch, makeCtx } from "./helpers.js";
import type { Target } from "../src/core/types.js";

beforeEach(() => resetExaMcpSession());

/** Fake replies for Exa's keyless MCP endpoint (used when EXA_API_KEY is unset). */
function mcpReply(body: any, results: unknown[]) {
  if (body?.method === "initialize") return { json: { jsonrpc: "2.0", id: body.id, result: {} } };
  if (body?.method === "notifications/initialized") return { text: "" };
  return { json: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ results }) }] } } };
}

const boris: Target = { name: "Boris Jabes", company: "Y Combinator", company_domain: "ycombinator.com" };

/** Routes Exa calls by includeDomains; everything else is a probe. */
function router(opts: {
  booking?: Array<{ url: string; title?: string; text?: string }>;
  paid?: Array<{ url: string; title?: string; text?: string }>;
  probe?: (url: string) => { status?: number; text?: string } | Promise<never>;
}) {
  return fakeFetch((url, body) => {
    if (url === "https://api.exa.ai/search") {
      const d: string[] = body.includeDomains ?? [];
      if (d.includes("calendly.com")) return { json: { results: opts.booking ?? [] } };
      if (d.includes("intro.co")) return { json: { results: opts.paid ?? [] } };
      return { json: { results: [] } };
    }
    if (opts.probe) return opts.probe(url) as any;
    return { status: 404, text: "not found" };
  });
}

describe("host matching", () => {
  it("accepts real domains and subdomains, rejects look-alikes", () => {
    expect(matchDomain("https://calendly.com/boris", BOOKING_DOMAINS)).toBe("calendly.com");
    expect(matchDomain("https://www.calendly.com/boris", BOOKING_DOMAINS)).toBe("calendly.com");
    expect(matchDomain("https://app.cal.com/boris", BOOKING_DOMAINS)).toBe("cal.com");
    expect(matchDomain("https://evilcalendly.com/boris", BOOKING_DOMAINS)).toBeUndefined();
    expect(matchDomain("https://calendly.com.evil.io/boris", BOOKING_DOMAINS)).toBeUndefined();
    expect(matchDomain("https://local.com/boris", BOOKING_DOMAINS)).toBeUndefined(); // not cal.com
    expect(matchDomain("https://notmeetings.hubspot.com/x", BOOKING_DOMAINS)).toBeUndefined();
    expect(matchDomain("https://meetings.hubspot.com/x", BOOKING_DOMAINS)).toBe("meetings.hubspot.com");
    expect(matchDomain("javascript:alert(1)//calendly.com", BOOKING_DOMAINS)).toBeUndefined();
    expect(matchDomain("not a url", BOOKING_DOMAINS)).toBeUndefined();
    expect(matchDomain("https://evilintro.co/x", PAID_DOMAINS)).toBeUndefined();
  });

  it("rejects platform marketing pages and non-appointment google calendar links", () => {
    expect(bookingPlatform("https://calendly.com/")).toBeUndefined();
    expect(bookingPlatform("https://calendly.com/pricing")).toBeUndefined();
    expect(bookingPlatform("https://cal.com/blog/post")).toBeUndefined();
    expect(bookingPlatform("https://calendar.google.com/calendar/embed?src=x")).toBeUndefined();
    expect(bookingPlatform("https://calendar.google.com/calendar/appointments/schedules/AcZ")).toBe("calendar.google.com");
    expect(bookingPlatform("https://calendar.app.google/abc123")).toBe("calendar.app.google");
    expect(paidPlatform("https://intro.co/borisjabes")).toBe("intro.co");
    expect(paidPlatform("https://adplist.org/")).toBeUndefined();
  });
});

describe("slugify and candidates", () => {
  it("handles accents, apostrophes and odd characters", () => {
    expect(slugify("José Álvarez")).toBe("jose-alvarez");
    expect(slugify("Seán O'Brien")).toBe("sean-obrien");
    expect(slugify("Anne-Marie  Dupré")).toBe("anne-marie-dupre");
    expect(slugify("Jürgen Groß")).toBe("jurgen-gross");
    expect(slugify("Łukasz Søren")).toBe("lukasz-soren");
    expect(slugify("  --Boris!! Jabes?? ")).toBe("boris-jabes");
    expect(slugify("王小明")).toBe("");
  });

  it("builds at most 5 candidates in the documented order", () => {
    expect(probeCandidates("Boris Jabes")).toEqual([
      "https://calendly.com/boris-jabes",
      "https://calendly.com/borisjabes",
      "https://calendly.com/boris",
      "https://cal.com/boris-jabes",
      "https://cal.com/borisjabes",
    ]);
    expect(probeCandidates("Dr. Seán O'Brien Jr.")[0]).toBe("https://calendly.com/sean-obrien");
    expect(probeCandidates("Madonna")).toEqual(["https://calendly.com/madonna"]);
    expect(probeCandidates("王小明")).toEqual([]);
  });
});

describe("containsName", () => {
  it("is case/accent-insensitive, whole-word, entity-aware", () => {
    expect(containsName("<title>BORIS JABES | Calendly</title>", boris)).toBe(true);
    expect(containsName("Boris&nbsp;Jabes", boris)).toBe(true);
    expect(containsName("Boris Jabesson", boris)).toBe(false);
    expect(containsName("Boris", boris)).toBe(false);
    expect(containsName("Meet Seán O&#39;Brien", { name: "Sean O'Brien" })).toBe(true);
  });
});

describe("probe_booking_page", () => {
  it("keeps booking bio links (high), ignores look-alikes, sends correct Exa params, does not probe", async () => {
    const { fetch, calls } = router({});
    const { ctx } = makeCtx(fetch);
    const r = await probe_booking_page(
      { target: boris, bioLinks: ["https://evilcalendly.com/boris", "https://calendly.com/borisj/30min", "https://x.com/borisjabes"] },
      ctx,
    );
    expect(r.pages).toEqual([{ url: "https://calendly.com/borisj/30min", platform: "calendly.com", source: "bio", verified_name: false }]);
    expect(r.probed).toEqual([]);
    const exa = calls.filter((c) => c.url === "https://api.exa.ai/search");
    expect(exa.length).toBe(2);
    expect(exa[0]!.body.includeDomains).toEqual([...BOOKING_DOMAINS]);
    expect(exa[0]!.body.query).toContain("Boris Jabes");
    expect(exa[1]!.body.includeDomains).toEqual([...PAID_DOMAINS]);
    expect(calls.every((c) => c.url === "https://api.exa.ai/search")).toBe(true);
    const f = ctx.findings.all();
    expect(f.length).toBe(1);
    expect(f[0]).toMatchObject({ kind: "booking_page", confidence: "high", source_url: "https://calendly.com/borisj/30min", step: "step2" });
    expect(summarizeProbeBookingPage(r)).toBe("found calendly.com/borisj/30min (from bio)");
  });

  it("search hits: medium when named, low otherwise; paid pages are their own kind", async () => {
    const { fetch } = router({
      booking: [
        { url: "https://calendly.com/boris-jabes", title: "Boris Jabes - 30 min" },
        { url: "https://calendly.com/someone-else", title: "Someone Else" },
        { url: "https://evilcalendly.com/boris", title: "Boris Jabes" },
        { url: "https://calendly.com/pricing", title: "Pricing" },
      ],
      paid: [{ url: "https://intro.co/borisjabes", title: "Book a call with Boris Jabes" }],
    });
    const { ctx } = makeCtx(fetch);
    const r = await probe_booking_page({ target: boris }, ctx);
    expect(r.pages.map((p) => [p.url, p.verified_name])).toEqual([
      ["https://calendly.com/boris-jabes", true],
      ["https://calendly.com/someone-else", false],
    ]);
    expect(r.paid).toEqual([{ url: "https://intro.co/borisjabes", platform: "intro.co", source: "search", verified_name: true }]);
    expect(r.probed).toEqual([]); // a named search hit counts as found
    const byUrl = Object.fromEntries(ctx.findings.all().map((f) => [f.source_url, f]));
    expect(byUrl["https://calendly.com/boris-jabes"]!.confidence).toBe("medium");
    expect(byUrl["https://calendly.com/someone-else"]!.confidence).toBe("low");
    expect(byUrl["https://intro.co/borisjabes"]!.kind).toBe("paid_consult_page");
  });

  it("probes only when nothing found; accepts 200 only if the page shows the full name", async () => {
    const { fetch, calls } = router({
      probe: (url) => {
        if (url === "https://calendly.com/boris-jabes") return { status: 200, text: "<html><title>Calendly</title>Page not found</html>" };
        if (url === "https://calendly.com/borisjabes") return { status: 200, text: "<html><title>Boris Jabes</title></html>" };
        return { status: 404 };
      },
    });
    const { ctx } = makeCtx(fetch);
    const r = await probe_booking_page({ target: boris }, ctx);
    expect(r.probed).toEqual(["https://calendly.com/boris-jabes", "https://calendly.com/borisjabes"]);
    expect(r.pages).toEqual([{ url: "https://calendly.com/borisjabes", platform: "calendly.com", source: "probe", verified_name: true }]);
    const probeCall = calls.find((c) => c.url === "https://calendly.com/borisjabes")!;
    expect(probeCall.init?.method).toBe("GET");
    expect(probeCall.init?.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.findings.all()[0]).toMatchObject({ kind: "booking_page", confidence: "medium" });
    expect(summarizeProbeBookingPage(r)).toBe("found calendly.com/borisjabes (URL guess, name on page)");
  });

  it("caps probes at 5 and swallows network errors", async () => {
    const { fetch, calls } = router({
      probe: () => Promise.reject(new TypeError("fetch failed")),
    });
    const { ctx } = makeCtx(fetch);
    const r = await probe_booking_page({ target: boris }, ctx);
    const probes = calls.filter((c) => c.url !== "https://api.exa.ai/search");
    expect(probes.length).toBe(5);
    expect(r.pages).toEqual([]);
    expect(summarizeProbeBookingPage(r)).toBe("no public booking page");
    expect(ctx.findings.all()).toEqual([]);
  });

  it("upgrades an unverified search hit when a probe proves it", async () => {
    const { fetch } = router({
      booking: [{ url: "https://calendly.com/boris-jabes", title: "30 Minute Meeting" }],
      probe: (url) => (url === "https://calendly.com/boris-jabes" ? { status: 200, text: "Boris Jabes" } : { status: 404 }),
    });
    const { ctx } = makeCtx(fetch);
    const r = await probe_booking_page({ target: boris }, ctx);
    expect(r.pages).toEqual([{ url: "https://calendly.com/boris-jabes", platform: "calendly.com", source: "search", verified_name: true }]);
    expect(ctx.findings.all()[0]!.confidence).toBe("medium");
  });

  it("keeps going when Exa fails or the key is missing", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url === "https://api.exa.ai/search") return { status: 401, text: "bad key" };
      return { status: 404 };
    });
    const { ctx } = makeCtx(fetch);
    const r = await probe_booking_page({ target: boris, bioLinks: ["https://cal.com/boris"] }, ctx);
    expect(r.pages.length).toBe(1);
    expect(r.errors).toEqual(["exa error 401", "exa error 401"]);

    // No EXA_API_KEY: exaSearch uses the keyless MCP endpoint; its results are still host-filtered.
    const keyless = fakeFetch((url, body) => {
      if (url === "https://mcp.exa.ai/mcp") {
        return mcpReply(body, [
          { url: "https://evilcalendly.com/boris", title: "Boris Jabes" },
          { url: "https://savvycal.com/boris", title: "Meet with Boris Jabes" },
        ]);
      }
      return { status: 404 };
    });
    const noKey = makeCtx(keyless.fetch, {});
    const r2 = await probe_booking_page({ target: boris }, noKey.ctx);
    expect(r2.errors).toEqual([]);
    expect(r2.pages).toEqual([{ url: "https://savvycal.com/boris", platform: "savvycal.com", source: "search", verified_name: true }]);
    expect(r2.probed.length).toBe(0);

    const down = makeCtx(fakeFetch((url) => (url === "https://mcp.exa.ai/mcp" ? { status: 503, text: "down" } : { status: 404 })).fetch, {});
    const r3 = await probe_booking_page({ target: boris }, down.ctx);
    expect(r3.errors).toEqual(["exa-mcp error 503", "exa-mcp error 503"]);
    expect(r3.probed.length).toBe(5);
  });
});
