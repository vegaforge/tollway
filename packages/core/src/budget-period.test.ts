import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CalendarPeriodKind,
  calendarDayKey,
  calendarMonthKey,
  calendarPeriodId,
  calendarWeekKey,
  isValidTimeZone,
  PeriodSpendLedger,
  type WeekStartsOn,
} from "./budget-period.js";
import { createPolicyEngine, type PaymentIntent } from "./policy.js";
import { PolicyValidationError, parsePolicy } from "./policy-schema.js";

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

const HOUR = 3_600_000;

describe("calendar period ids (#198)", () => {
  // Each row: an instant, a zone, and the period it belongs to. The expected
  // local dates were checked against Python's zoneinfo.
  const rows: Array<[string, CalendarPeriodKind, string, string, WeekStartsOn?]> = [
    // America/New_York, DST starts 2026-03-08: a 23 hour day.
    ["2026-03-08T04:59:59Z", "day", "America/New_York", "day:2026-03-07@America/New_York"],
    ["2026-03-08T05:00:00Z", "day", "America/New_York", "day:2026-03-08@America/New_York"],
    ["2026-03-09T03:59:59Z", "day", "America/New_York", "day:2026-03-08@America/New_York"],
    ["2026-03-09T04:00:00Z", "day", "America/New_York", "day:2026-03-09@America/New_York"],
    // America/New_York, DST ends 2026-11-01: a 25 hour day.
    ["2026-11-01T03:59:59Z", "day", "America/New_York", "day:2026-10-31@America/New_York"],
    ["2026-11-01T04:00:00Z", "day", "America/New_York", "day:2026-11-01@America/New_York"],
    ["2026-11-02T04:59:59Z", "day", "America/New_York", "day:2026-11-01@America/New_York"],
    ["2026-11-02T05:00:00Z", "day", "America/New_York", "day:2026-11-02@America/New_York"],
    // Europe/London, BST starts 2026-03-29: a 23 hour day.
    ["2026-03-28T23:59:59Z", "day", "Europe/London", "day:2026-03-28@Europe/London"],
    ["2026-03-29T00:00:00Z", "day", "Europe/London", "day:2026-03-29@Europe/London"],
    ["2026-03-29T22:59:59Z", "day", "Europe/London", "day:2026-03-29@Europe/London"],
    ["2026-03-29T23:00:00Z", "day", "Europe/London", "day:2026-03-30@Europe/London"],
    // Europe/London, BST ends 2026-10-25: a 25 hour day.
    ["2026-10-24T22:59:59Z", "day", "Europe/London", "day:2026-10-24@Europe/London"],
    ["2026-10-24T23:00:00Z", "day", "Europe/London", "day:2026-10-25@Europe/London"],
    ["2026-10-25T23:59:59Z", "day", "Europe/London", "day:2026-10-25@Europe/London"],
    ["2026-10-26T00:00:00Z", "day", "Europe/London", "day:2026-10-26@Europe/London"],
    // Month ends seen from either side of UTC.
    ["2026-12-01T04:59:59Z", "month", "America/New_York", "month:2026-11@America/New_York"],
    ["2026-11-30T15:00:00Z", "month", "Asia/Tokyo", "month:2026-12@Asia/Tokyo"],
    ["2026-12-31T23:30:00Z", "day", "Asia/Tokyo", "day:2027-01-01@Asia/Tokyo"],
    ["2026-12-31T23:30:00Z", "month", "Asia/Tokyo", "month:2027-01@Asia/Tokyo"],
    // Leap day.
    ["2028-02-29T12:00:00Z", "day", "UTC", "day:2028-02-29@UTC"],
    ["2028-02-29T12:00:00Z", "month", "UTC", "month:2028-02@UTC"],
    ["2028-03-01T00:00:00Z", "month", "UTC", "month:2028-03@UTC"],
    ["2028-03-01T00:00:00Z", "week", "UTC", "week:2028-02-28@UTC", "monday"],
    ["2028-03-01T00:00:00Z", "week", "UTC", "week:2028-02-27@UTC", "sunday"],
    // A week that crosses the year end. 2027-01-01 is a Friday.
    ["2026-12-31T23:30:00Z", "week", "Asia/Tokyo", "week:2026-12-28@Asia/Tokyo", "monday"],
    ["2026-12-31T23:30:00Z", "week", "Asia/Tokyo", "week:2026-12-27@Asia/Tokyo", "sunday"],
    // A week boundary in a zone behind UTC: Monday 00:30 UTC is still Sunday in New York.
    [
      "2026-11-30T00:30:00Z",
      "week",
      "America/New_York",
      "week:2026-11-23@America/New_York",
      "monday",
    ],
    [
      "2026-11-30T05:00:00Z",
      "week",
      "America/New_York",
      "week:2026-11-30@America/New_York",
      "monday",
    ],
  ];

  it.each(rows)("%s %s in %s is %s", (instant, kind, zone, expected, weekStartsOn) => {
    expect(calendarPeriodId(kind, Date.parse(instant), zone, weekStartsOn)).toBe(expected);
  });

  it("counts a 23 hour and a 25 hour local day as one period each", () => {
    const periodsIn = (zone: string, fromIso: string, hours: number) => {
      const start = Date.parse(fromIso);
      const ids = new Set<string>();
      for (let h = 0; h < hours; h += 1) ids.add(calendarPeriodId("day", start + h * HOUR, zone));
      return ids;
    };
    // Local midnight to local midnight, in hours of real time.
    expect(periodsIn("America/New_York", "2026-03-08T05:00:00Z", 23)).toEqual(
      new Set(["day:2026-03-08@America/New_York"]),
    );
    expect(periodsIn("America/New_York", "2026-11-01T04:00:00Z", 25)).toEqual(
      new Set(["day:2026-11-01@America/New_York"]),
    );
    expect(periodsIn("Europe/London", "2026-03-29T00:00:00Z", 23)).toEqual(
      new Set(["day:2026-03-29@Europe/London"]),
    );
    expect(periodsIn("Europe/London", "2026-10-24T23:00:00Z", 25)).toEqual(
      new Set(["day:2026-10-25@Europe/London"]),
    );
  });

  it("is monotonic non-decreasing in time for a given zone and kind", () => {
    const zones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Lord_Howe"];
    // 1970 to 2100, the range a budget clock can plausibly report.
    const instant = fc.integer({ min: 0, max: 4_102_444_800_000 });
    fc.assert(
      fc.property(
        instant,
        instant,
        fc.constantFrom(...zones),
        fc.constantFrom<CalendarPeriodKind>("day", "week", "month"),
        fc.constantFrom<WeekStartsOn>("monday", "sunday"),
        (a, b, zone, kind, weekStartsOn) => {
          const [earlier, later] = a <= b ? [a, b] : [b, a];
          const first = calendarPeriodId(kind, earlier, zone, weekStartsOn);
          const second = calendarPeriodId(kind, later, zone, weekStartsOn);
          expect(first <= second).toBe(true);
        },
      ),
    );
  });
});

describe("PeriodSpendLedger (#198)", () => {
  const dayInUtc = (t: number) => calendarPeriodId("day", t, "UTC");

  it("keeps spend per period and drops closed periods", () => {
    const ledger = new PeriodSpendLedger(dayInUtc);
    const monday = Date.parse("2026-11-23T12:00:00Z");
    ledger.add(monday, "USDC", 40n);
    ledger.add(monday, "EURC", 5n);
    expect(ledger.spent(monday, "USDC")).toBe(40n);
    expect(ledger.size).toBe(2);

    const tuesday = monday + 24 * HOUR;
    expect(ledger.spent(tuesday, "USDC")).toBe(0n);
    ledger.add(tuesday, "USDC", 1n);
    // Monday's two entries are gone; only Tuesday's one is held.
    expect(ledger.size).toBe(1);
  });

  it("never moves back to a period that has closed", () => {
    const ledger = new PeriodSpendLedger(dayInUtc);
    const afterMidnight = Date.parse("2026-11-24T00:05:00Z");
    ledger.add(afterMidnight, "USDC", 100n);
    const beforeMidnight = Date.parse("2026-11-23T23:59:00Z");
    expect(ledger.period(beforeMidnight)).toBe("day:2026-11-24@UTC");
    expect(ledger.spent(beforeMidnight, "USDC")).toBe(100n);
    // Spend at the stepped-back time counts once, in the current period.
    ledger.add(beforeMidnight, "USDC", 1n);
    expect(ledger.spent(afterMidnight, "USDC")).toBe(101n);
  });
});

describe("periodic budgets across boundaries (#198)", () => {
  it("does not count spend from one period in the next", async () => {
    let now = Date.parse("2026-03-08T05:30:00Z"); // 00:30 EST, the 23 hour day
    const engine = createPolicyEngine(
      { budgets: { daily: "100", timezone: "America/New_York" } },
      { clock: () => now },
    );
    await engine.record(intent("60"));
    now = Date.parse("2026-03-09T03:30:00Z"); // 23:30 EDT, same local day
    await engine.record(intent("40"));
    expect((await engine.check(intent("1"))).allowed).toBe(false);
    now = Date.parse("2026-03-09T04:00:00Z"); // 00:00 EDT, next local day
    expect((await engine.check(intent("100"))).allowed).toBe(true);
  });

  it("lets calendar-day spend twice around midnight, and rolling 24h blocks it", async () => {
    let now = Date.parse("2026-11-24T23:59:00Z");
    const calendar = createPolicyEngine({ budgets: { daily: "100" } }, { clock: () => now });
    const rolling = createPolicyEngine(
      { budgets: { rolling: { windowSeconds: 86_400, cap: "100" } } },
      { clock: () => now },
    );
    await calendar.record(intent("100"));
    await rolling.record(intent("100"));

    now = Date.parse("2026-11-25T00:01:00Z");
    // The calendar day has turned, so the full budget is available again.
    expect((await calendar.check(intent("100"))).allowed).toBe(true);
    // The last 24 hours already hold 100, so the rolling budget refuses.
    expect((await rolling.check(intent("1"))).allowed).toBe(false);
  });

  it("does not reopen a closed period when the clock steps backwards", async () => {
    let now = Date.parse("2026-12-01T00:05:00Z");
    const engine = createPolicyEngine(
      { budgets: { daily: "100", weekly: "100", monthly: "100" } },
      { clock: () => now },
    );
    await engine.record(intent("100"));
    // Back across a day and a month boundary. Both instants are in the week
    // that starts on Monday 2026-11-30.
    now = Date.parse("2026-11-30T23:59:00Z");
    const trace = await engine.evaluate(intent("1"));
    const outcome = (id: string) => trace.entries.find((e) => e.id === id)?.outcome;
    expect(outcome("budget-daily")).toBe("fail");
    expect(outcome("budget-weekly")).toBe("fail");
    expect(outcome("budget-monthly")).toBe("fail");
    // The trace reports the period the spend counts toward, not the stepped-back one.
    expect(trace.entries.find((e) => e.id === "budget-monthly")?.window).toEqual({
      kind: "calendar-month",
      month: "2026-12",
      timezone: "UTC",
    });
    expect((await engine.headroom?.("USDC:GA5Z", "GSERVICE"))?.headroom).toBe("0");
  });

  it("applies daily and monthly budgets at once, each with its own rule", async () => {
    let now = Date.parse("2026-11-29T12:00:00Z");
    const engine = createPolicyEngine(
      { budgets: { daily: "60", monthly: "100" } },
      { clock: () => now },
    );
    await engine.record(intent("60"));
    expect((await engine.evaluate(intent("1"))).blockedBy).toBe("budget-daily");
    now = Date.parse("2026-11-30T12:00:00Z");
    await engine.record(intent("30"));
    const trace = await engine.evaluate(intent("20"));
    expect(trace.blockedBy).toBe("budget-monthly");
    expect(trace.entries.find((e) => e.id === "budget-daily")?.outcome).toBe("pass");
  });
});
