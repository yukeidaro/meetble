import { describe, expect, it } from "vitest";
import { dateOf, findingEvents } from "../server.mjs";

const now = new Date(2026, 10, 11, 20, 0); // Nov 11, 2026

describe("dateOf", () => {
  it("labels and sorts dates for the timeline", () => {
    expect(dateOf("2025-05", now)).toEqual({ date: "May 2025", ts: 202505010000 });
    expect(dateOf("2026-11-09", now)).toEqual({ date: "Nov 9", ts: 202611090000 });
    expect(dateOf("2025-10-14", now)).toEqual({ date: "Oct 14, 2025", ts: 202510140000 });
    expect(dateOf("2026-11-11T22:45", now)).toEqual({ date: "Today · 22:45", ts: 202611112245 });
    expect(dateOf("", now)).toEqual({});
  });

  it("puts dates on now/precedent findings only", () => {
    const evs = findingEvents({ findings: [
      { dimension: "web", kind: "bio", claim: "Partner", date: "2025-01-01" },
      { dimension: "event", claim: "Judging", date: "2026-11-11" },
    ] });
    expect(evs[0].ts).toBeUndefined();
    expect(evs[1].section).toBe("now");
    expect(typeof evs[1].ts).toBe("number");
  });
});
