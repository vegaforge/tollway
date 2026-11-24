import { describe, expect, it } from "vitest";
import {
  calendarDayKey,
  calendarMonthKey,
  calendarWeekKey,
  isValidTimeZone,
} from "./budget-period.js";
import { createPolicyEngine, type PaymentIntent } from "./policy.js";
import { parsePolicy, PolicyValidationError } from "./policy-schema.js";

function intent(amount = "100"): PaymentIntent {
  return {
    payee: "GSERVICE",
    resource: "/api/quotes",
    amount,
    asset: "USDC:GA5Z",
    model: "x402",
  };
}

describe("budget-period helpers (#198)", () => {
  it("validates IANA time zones without external dependencies", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("computes local calendar day across timezone midnight boundaries", () => {
    // 2026-11-24T04:59:59Z is 2026-11-23 23:59:59 EST in America/New_York
    const beforeLocalMidnight = Date.parse("2026-11-24T04:59:59Z");
    // 2026-11-24T05:00:00Z is 2026-11-24 00:00:00 EST in America/New_York
    const atLocalMidnight = Date.parse("2026-11-24T05:00:00Z");

    expect(calendarDayKey(beforeLocalMidnight, "UTC")).toBe("2026-11-24");
    expect(calendarDayKey(beforeLocalMidnight, "America/New_York")).toBe("2026-11-23");
    expect(calendarDayKey(atLocalMidnight, "America/New_York")).toBe("2026-11-24");
  });

  it("handles DST spring-forward without resetting early", () => {
    // America/New_York springs forward on 2026-03-08 at 02:00 EST -> 03:00 EDT.
    const beforeSpring = Date.parse("2026-03-08T06:59:00Z"); // 01:59 EST
    const afterSpring = Date.parse("2026-03-08T07:01:00Z"); // 03:01 EDT
    const nextMidnight = Date.parse("2026-03-09T04:00:00Z"); // 00:00 EDT

    expect(calendarDayKey(beforeSpring, "America/New_York")).toBe("2026-03-08");
    expect(calendarDayKey(afterSpring, "America/New_York")).toBe("2026-03-08");
    expect(calendarDayKey(nextMidnight, "America/New_York")).toBe("2026-03-09");
  });

  it("handles DST fall-back without double-resetting", () => {
    // America/New_York falls back on 2026-11-01 at 02:00 EDT -> 01:00 EST.
    const firstOneThirty = Date.parse("2026-11-01T05:30:00Z"); // 01:30 EDT
    const secondOneThirty = Date.parse("2026-11-01T06:30:00Z"); // 01:30 EST
    const endOfDayEst = Date.parse("2026-11-02T04:59:59Z"); // 23:59:59 EST on Nov 1
    const nextDayEst = Date.parse("2026-11-02T05:00:00Z"); // 00:00:00 EST on Nov 2

    expect(calendarDayKey(firstOneThirty, "America/New_York")).toBe("2026-11-01");
    expect(calendarDayKey(secondOneThirty, "America/New_York")).toBe("2026-11-01");
    expect(calendarDayKey(endOfDayEst, "America/New_York")).toBe("2026-11-01");
    expect(calendarDayKey(nextDayEst, "America/New_York")).toBe("2026-11-02");
  });

  it("computes weekly and monthly keys for monday and sunday week starts", () => {
    // 2026-11-29 is a Sunday
    const sunday = Date.parse("2026-11-29T12:00:00Z");
    const monday = Date.parse("2026-11-30T12:00:00Z");
    const nextMonth = Date.parse("2026-12-01T00:00:00Z");

    expect(calendarWeekKey(sunday, "UTC", "monday")).toBe("2026-11-23");
    expect(calendarWeekKey(monday, "UTC", "monday")).toBe("2026-11-30");
    expect(calendarWeekKey(sunday, "UTC", "sunday")).toBe("2026-11-29");
    expect(calendarWeekKey(monday, "UTC", "sunday")).toBe("2026-11-29");

    expect(calendarMonthKey(monday, "UTC")).toBe("2026-11");
    expect(calendarMonthKey(nextMonth, "UTC")).toBe("2026-12");
  });
});

describe("periodic budgets in PolicyEngine (#198)", () => {
  it("rejects invalid IANA time zones at schema parse and engine creation", () => {
    const parsed = parsePolicy({
      policyVersion: 1,
      budgets: { daily: "100", timezone: "Invalid/Zone" },
    });
    expect(parsed.ok).toBe(false);
    expect(() =>
      createPolicyEngine({ budgets: { daily: "100", timezone: "Invalid/Zone" } }),
    ).toThrow(PolicyValidationError);
  });

  it("resets daily budget at local midnight in the configured timezone", async () => {
    let now = Date.parse("2026-11-24T04:50:00Z"); // 23:50 EST on 2026-11-23
    const engine = createPolicyEngine(
      { budgets: { daily: "100", timezone: "America/New_York" } },
      { clock: () => now },
    );

    await engine.record(intent("100"));
    expect((await engine.check(intent("1"))).allowed).toBe(false);

    // 00:05 EST on 2026-11-24 (05:05Z) -> new local day, budget resets
    now = Date.parse("2026-11-24T05:05:00Z");
    const trace = await engine.evaluate(intent("100"));
    expect(trace.allowed).toBe(true);
    const dailyEntry = trace.entries.find((e) => e.id === "budget-daily");
    expect(dailyEntry?.window).toEqual({
      kind: "calendar-day",
      day: "2026-11-24",
      timezone: "America/New_York",
    });
  });

  it("enforces weekly and monthly budgets across boundaries", async () => {
    let now = Date.parse("2026-11-29T12:00:00Z"); // Sunday
    const engine = createPolicyEngine(
      {
        budgets: {
          weekly: "150",
          monthly: "200",
          weekStartsOn: "monday",
          timezone: "UTC",
        },
      },
      { clock: () => now },
    );

    await engine.record(intent("150"));
    expect((await engine.check(intent("1"))).allowed).toBe(false);

    // Monday 2026-11-30 -> new week, same month (50 remaining in monthly)
    now = Date.parse("2026-11-30T00:00:00Z");
    expect((await engine.check(intent("50"))).allowed).toBe(true);
    expect((await engine.check(intent("51"))).allowed).toBe(false);

    // Tuesday 2026-12-01 -> same week, new month
    now = Date.parse("2026-12-01T00:00:00Z");
    await engine.record(intent("50"));
    expect((await engine.check(intent("100"))).allowed).toBe(true);
    expect((await engine.check(intent("101"))).allowed).toBe(false);
  });

  it("prevents midnight gaming with a rolling 24h budget", async () => {
    let now = Date.parse("2026-11-24T23:59:00Z");
    const engine = createPolicyEngine(
      { budgets: { rolling: { windowSeconds: 86_400, cap: "100" } } },
      { clock: () => now },
    );

    await engine.record(intent("100"));

    // Two minutes later at 00:01 UTC, the rolling 24h budget is still exhausted.
    now = Date.parse("2026-11-25T00:01:00Z");
    const blocked = await engine.check(intent("1"));
    expect(blocked.allowed).toBe(false);

    // After 24h + 1 bucket, the rolling window drains and allows spend again.
    now += 86_400_000 + 86_400_000 / 60 + 1_000;
    expect((await engine.check(intent("100"))).allowed).toBe(true);
  });

  it("includes rolling, weekly, and monthly budgets in headroom()", async () => {
    const engine = createPolicyEngine({
      budgets: {
        daily: "500",
        weekly: "400",
        monthly: "300",
        rolling: { windowSeconds: 3600, cap: "200" },
        total: "1000",
      },
    });
    await engine.record(intent("50"));
    const headroom = await engine.headroom?.("USDC:GA5Z", "GSERVICE");
    expect(headroom).toEqual({
      asset: "USDC:GA5Z",
      payee: "GSERVICE",
      headroom: "150",
      limitedBy: "budget-rolling",
    });
  });
});
