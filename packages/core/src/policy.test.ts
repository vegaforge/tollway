import { describe, expect, it } from "vitest";
import { TollwayError } from "./errors.js";
import type { PaymentIntent } from "./policy.js";
import { createPolicyEngine } from "./policy.js";
import { type PolicyInput, PolicyValidationError } from "./policy-schema.js";

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    payee: "GSERVICE",
    resource: "/api/quotes",
    amount: "100",
    asset: "USDC:GA5Z",
    model: "x402",
    ...overrides,
  };
}

describe("createPolicyEngine", () => {
  describe("daily budget", () => {
    it("allows payments within the daily budget", async () => {
      const engine = createPolicyEngine({ budgets: { daily: "200" } });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when daily budget is exceeded", async () => {
      const engine = createPolicyEngine({ budgets: { daily: "150" } });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "budget",
        detail: expect.stringContaining("daily budget exceeded"),
      });
    });

    it("resets daily spend on a new UTC day", async () => {
      let now = new Date("2026-06-10T12:00:00Z").getTime();
      const engine = createPolicyEngine({ budgets: { daily: "150" } }, { clock: () => now });
      await engine.record(intent({ amount: "100" }));
      const before = await engine.check(intent({ amount: "100" }));
      expect(before).toEqual({ allowed: false, rule: "budget", detail: expect.any(String) });

      now = new Date("2026-06-11T00:01:00Z").getTime();
      const after = await engine.check(intent({ amount: "100" }));
      expect(after).toEqual({ allowed: true });
    });
  });

  describe("total budget", () => {
    it("allows payments within the total budget", async () => {
      const engine = createPolicyEngine({ budgets: { total: "500" } });
      const result = await engine.check(intent({ amount: "200" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when total budget is exceeded", async () => {
      const engine = createPolicyEngine({ budgets: { total: "250" } });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "budget",
        detail: expect.stringContaining("total budget exceeded"),
      });
    });
  });

  describe("per-service cap", () => {
    it("allows payments within the service cap", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { cap: "200" } },
      });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when per-service cap is exceeded", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { cap: "150" } },
      });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-service",
        detail: expect.stringContaining("per-service cap exceeded"),
      });
    });

    it("tracks per-service spend per asset", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { cap: "150" } },
      });
      await engine.record(intent({ amount: "100", asset: "USDC:GA5Z" }));
      const result = await engine.check(intent({ amount: "100", asset: "EURC:GBBB" }));
      expect(result).toEqual({ allowed: true });
    });
  });

  describe("per-model constraints", () => {
    it("blocks a disabled settlement model", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { enabled: false } },
      });
      const result = await engine.check(intent({ model: "mpp-channel" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-model-disabled",
        detail: expect.stringContaining("disabled by policy"),
      });
    });

    it("allows an enabled settlement model", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { enabled: true } },
      });
      const result = await engine.check(intent({ model: "mpp-channel" }));
      expect(result).toEqual({ allowed: true });
    });

    // #181: the minimum deposit guards opening a channel. A per-request channel
    // payment is priced far below any deposit, so comparing the two blocked
    // every channel payment. Before the fix, the first test below was blocked.
    it("does not block a channel payment because its price is below the minimum deposit", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { minChannelDeposit: "1000000" } },
      });
      const result = await engine.check(intent({ model: "mpp-channel", amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks a channel open whose deposit is below the minimum", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { minChannelDeposit: "200" } },
      });
      const result = await engine.evaluateChannelOpen?.({
        payee: "GSERVICE",
        asset: "USDC:GA5Z",
        deposit: "100",
      });
      expect(result).toEqual({
        allowed: false,
        wouldBlock: true,
        rule: "min-channel-deposit",
        detail: expect.stringContaining("below minimum channel deposit"),
      });
    });

    it("allows a channel open at the minimum deposit", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { minChannelDeposit: "100" } },
      });
      const result = await engine.evaluateChannelOpen?.({
        payee: "GSERVICE",
        asset: "USDC:GA5Z",
        deposit: "100",
      });
      expect(result).toMatchObject({ allowed: true, wouldBlock: false, rule: null });
    });

    it("reports a disabled model before budget", async () => {
      const engine = createPolicyEngine({
        budgets: { daily: "50" },
        perModel: { "mpp-channel": { enabled: false } },
      });
      const result = await engine.check(intent({ model: "mpp-channel", amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-model-disabled",
        detail: expect.any(String),
      });
    });
  });

  describe("rate limit", () => {
    it("allows requests within the rate limit", async () => {
      const engine = createPolicyEngine({
        rateLimit: { requestsPerMinute: 3 },
      });
      await engine.record(intent({ amount: "10" }));
      await engine.record(intent({ amount: "10" }));
      const result = await engine.check(intent({ amount: "10" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when rate limit is exceeded", async () => {
      const engine = createPolicyEngine({
        rateLimit: { requestsPerMinute: 2 },
      });
      await engine.record(intent({ amount: "10" }));
      await engine.record(intent({ amount: "10" }));
      const result = await engine.check(intent({ amount: "10" }));
      expect(result).toEqual({
        allowed: false,
        rule: "rate-limit",
        detail: expect.stringContaining("rate limit exceeded"),
      });
    });

    it("allows requests after the window rolls", async () => {
      let now = new Date("2026-06-10T12:00:00Z").getTime();
      const engine = createPolicyEngine(
        { rateLimit: { requestsPerMinute: 2 } },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "10" }));
      await engine.record(intent({ amount: "10" }));
      const blocked = await engine.check(intent({ amount: "10" }));
      expect(blocked).toEqual({ allowed: false, rule: "rate-limit", detail: expect.any(String) });

      now = new Date("2026-06-10T12:01:05Z").getTime();
      const allowed = await engine.check(intent({ amount: "10" }));
      expect(allowed).toEqual({ allowed: true });
    });
  });

  // Issue #197 coverage.
  describe("rate-limit (#197) semantics", () => {
    const T0 = Date.parse("2026-06-10T12:00:00Z");

    function clockAt(start = T0) {
      const clock = { now: start };
      return { clock, opts: { clock: () => clock.now } };
    }

    function issuePaths(fn: () => unknown): string[] {
      let thrown: unknown;
      try {
        fn();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PolicyValidationError);
      return (thrown as PolicyValidationError).issues.map((issue) => issue.path.join("."));
    }

    it.each([
      [
        "both requestsPerMinute and windows",
        { requestsPerMinute: 5, windows: [{ windowSeconds: 60, limit: 5 }] },
        "rateLimit.windows",
      ],
      [
        "a window of zero seconds",
        { windows: [{ windowSeconds: 0, limit: 5 }] },
        "rateLimit.windows.0.windowSeconds",
      ],
      [
        "a fractional limit",
        { windows: [{ windowSeconds: 60, limit: 2.5 }] },
        "rateLimit.windows.0.limit",
      ],
      ["an empty windows list", { windows: [] }, "rateLimit.windows"],
      [
        "a key limit of zero",
        { requestsPerMinute: 5, scope: "per-counterparty", perCounterpartyKeyLimit: 0 },
        "rateLimit.perCounterpartyKeyLimit",
      ],
      [
        "a negative key limit",
        { requestsPerMinute: 5, scope: "per-counterparty", perCounterpartyKeyLimit: -1 },
        "rateLimit.perCounterpartyKeyLimit",
      ],
      ["an unknown count", { requestsPerMinute: 5, count: "requests" }, "rateLimit.count"],
    ])("refuses %s when the engine is created", (_name, rateLimit, path) => {
      // Policies arrive as JSON, so the cases include values the type forbids.
      const input = { rateLimit } as unknown as PolicyInput;
      expect(issuePaths(() => createPolicyEngine(input))).toContain(path);
    });

    it("never changes state from evaluate or check, even when counting attempts", async () => {
      const engine = createPolicyEngine({
        rateLimit: { windows: [{ windowSeconds: 60, limit: 1 }], count: "attempts" },
      });
      // Shadow comparisons, dry runs and retries evaluate without paying.
      for (let i = 0; i < 3; i += 1) {
        expect((await engine.evaluate(intent())).allowed).toBe(true);
        expect(await engine.check(intent())).toEqual({ allowed: true });
      }
    });

    it("counts an attempt when admit allows it, and not when admit blocks it", async () => {
      const engine = createPolicyEngine({
        rateLimit: { windows: [{ windowSeconds: 60, limit: 2 }], count: "attempts" },
      });
      expect((await engine.admit?.(intent()))?.allowed).toBe(true);
      expect((await engine.admit?.(intent()))?.allowed).toBe(true);
      const third = await engine.admit?.(intent());
      expect(third?.allowed).toBe(false);
      expect(third?.blockedBy).toBe("rate-limit");
      // The blocked attempt was not counted: one slot frees when the first
      // two age out, not later.
    });

    it("lets only one of several concurrent attempts take the last slot", async () => {
      const engine = createPolicyEngine({
        rateLimit: { windows: [{ windowSeconds: 60, limit: 1 }], count: "attempts" },
      });
      const traces = await Promise.all(Array.from({ length: 8 }, () => engine.admit?.(intent())));
      expect(traces.filter((trace) => trace?.allowed)).toHaveLength(1);
    });

    it("counts a shadow's attempts through recordAttempt", async () => {
      const engine = createPolicyEngine({
        rateLimit: { windows: [{ windowSeconds: 60, limit: 1 }], count: "attempts" },
      });
      await engine.recordAttempt?.(intent());
      expect((await engine.check(intent())).allowed).toBe(false);
    });

    it("counts settlements on record only, never on admit", async () => {
      const engine = createPolicyEngine({
        rateLimit: { windows: [{ windowSeconds: 60, limit: 1 }] },
      });
      await engine.admit?.(intent());
      await engine.recordAttempt?.(intent());
      expect((await engine.check(intent())).allowed).toBe(true);
      await engine.record(intent());
      expect((await engine.check(intent())).allowed).toBe(false);
    });

    describe.each([
      ["settlements", "global"],
      ["settlements", "per-counterparty"],
      ["attempts", "global"],
      ["attempts", "per-counterparty"],
    ] as const)("count %s, scope %s", (count, scope) => {
      async function countOne(
        engine: ReturnType<typeof createPolicyEngine>,
        payee: string,
      ): Promise<void> {
        if (count === "settlements") await engine.record(intent({ payee }));
        else expect((await engine.admit?.(intent({ payee })))?.allowed).toBe(true);
      }

      it("still counts an event exactly windowSeconds old, and drops it one millisecond later", async () => {
        const { clock, opts } = clockAt();
        const engine = createPolicyEngine(
          { rateLimit: { windows: [{ windowSeconds: 60, limit: 1 }], count, scope } },
          opts,
        );
        await countOne(engine, "GA");
        clock.now = T0 + 60_000;
        expect((await engine.check(intent({ payee: "GA" }))).allowed).toBe(false);
        clock.now = T0 + 60_001;
        expect((await engine.check(intent({ payee: "GA" }))).allowed).toBe(true);
      });

      it(
        scope === "global" ? "shares one count across payees" : "keeps a count per payee",
        async () => {
          const engine = createPolicyEngine({
            rateLimit: { windows: [{ windowSeconds: 60, limit: 1 }], count, scope },
          });
          await countOne(engine, "GA");
          expect((await engine.check(intent({ payee: "GB" }))).allowed).toBe(scope !== "global");
        },
      );

      it("names the scope, the counterparty and the count in the detail", async () => {
        const engine = createPolicyEngine({
          rateLimit: { windows: [{ windowSeconds: 60, limit: 1 }], count, scope },
        });
        await countOne(engine, "GSERVICE");
        const trace = await engine.evaluate(intent({ payee: "GSERVICE" }));
        const line = trace.entries.find((entry) => entry.id === "rate-limit");
        const noun = count === "attempts" ? "1 attempts" : "1 settled payments";
        expect(line?.detail).toBe(
          scope === "global"
            ? `global rate limit exceeded: ${noun} in the last 60 seconds, limit 1`
            : `per-counterparty rate limit for GSERVICE exceeded: ${noun} in the last 60 seconds, limit 1`,
        );
        expect(line).toMatchObject({ limit: "1", current: "1", projected: "2" });
      });
    });

    it("applies every window: a free minute does not hide a full hour", async () => {
      const { clock, opts } = clockAt();
      const engine = createPolicyEngine(
        {
          rateLimit: {
            windows: [
              { windowSeconds: 60, limit: 100 },
              { windowSeconds: 3600, limit: 2 },
            ],
          },
        },
        opts,
      );
      await engine.record(intent());
      await engine.record(intent());
      clock.now = T0 + 70_000;
      const trace = await engine.evaluate(intent());
      const line = trace.entries.find((entry) => entry.id === "rate-limit");
      expect(line).toMatchObject({ outcome: "fail", window: { kind: "sliding", seconds: 3600 } });
    });

    it("uses its own window, independent of the one-minute anomaly window", async () => {
      const { clock, opts } = clockAt();
      const engine = createPolicyEngine(
        {
          rateLimit: { windows: [{ windowSeconds: 600, limit: 1 }] },
          anomaly: { maxSpendPerMinute: "150" },
        },
        opts,
      );
      await engine.record(intent({ amount: "100" }));
      clock.now = T0 + 120_000;
      const trace = await engine.evaluate(intent({ amount: "100" }));
      const outcome = (id: string) => trace.entries.find((entry) => entry.id === id)?.outcome;
      expect(outcome("anomaly")).toBe("pass");
      expect(outcome("rate-limit")).toBe("fail");
    });

    it("stays exact after many more events than the limit", async () => {
      const { clock, opts } = clockAt();
      const engine = createPolicyEngine(
        { mode: "dry-run", rateLimit: { windows: [{ windowSeconds: 60, limit: 3 }] } },
        opts,
      );
      for (let i = 0; i < 500; i += 1) {
        clock.now = T0 + i;
        await engine.record(intent());
      }
      // Only the newest three events (at T0+497, +498, +499) matter. All
      // three are in the window at T0+497+60s, and one has left it 1ms later.
      clock.now = T0 + 497 + 60_000;
      expect((await engine.evaluate(intent())).wouldBlock).toBe(true);
      clock.now = T0 + 497 + 60_001;
      expect((await engine.evaluate(intent())).wouldBlock).toBe(false);
    });

    describe("per-counterparty key limit", () => {
      const policy: PolicyInput = {
        rateLimit: {
          windows: [{ windowSeconds: 60, limit: 1 }],
          scope: "per-counterparty",
          perCounterpartyKeyLimit: 2,
        },
      };

      it("refuses a new counterparty while every tracked one is active", async () => {
        const engine = createPolicyEngine(policy);
        await engine.record(intent({ payee: "GA" }));
        await engine.record(intent({ payee: "GB" }));
        const trace = await engine.evaluate(intent({ payee: "GC" }));
        const line = trace.entries.find((entry) => entry.id === "rate-limit");
        expect(line?.outcome).toBe("fail");
        expect(line?.detail).toContain("already tracking 2 active counterparties");
      });

      it("never forgets an active counterparty to make room, so its limit holds", async () => {
        const engine = createPolicyEngine({ ...policy, mode: "dry-run" });
        await engine.record(intent({ payee: "GA" }));
        await engine.record(intent({ payee: "GB" }));
        // A dry-run payment to a third payee is allowed and recorded, but
        // there is no room to track it.
        await engine.record(intent({ payee: "GC" }));
        expect((await engine.evaluate(intent({ payee: "GA" }))).wouldBlock).toBe(true);
        expect((await engine.evaluate(intent({ payee: "GB" }))).wouldBlock).toBe(true);
        expect((await engine.evaluate(intent({ payee: "GC" }))).wouldBlock).toBe(true);
      });

      it("drops idle counterparties to make room for a new one", async () => {
        const { clock, opts } = clockAt();
        const engine = createPolicyEngine(policy, opts);
        await engine.record(intent({ payee: "GA" }));
        await engine.record(intent({ payee: "GB" }));
        clock.now = T0 + 61_000;
        expect((await engine.check(intent({ payee: "GC" }))).allowed).toBe(true);
        await engine.record(intent({ payee: "GC" }));
        await engine.record(intent({ payee: "GD" }));
        expect((await engine.check(intent({ payee: "GC" }))).allowed).toBe(false);
        expect((await engine.check(intent({ payee: "GD" }))).allowed).toBe(false);
      });
    });
  });

  describe("anomaly stop", () => {
    it("allows spending within the anomaly threshold", async () => {
      const engine = createPolicyEngine({
        anomaly: { maxSpendPerMinute: "500" },
      });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when projected spend exceeds anomaly threshold", async () => {
      const engine = createPolicyEngine({
        anomaly: { maxSpendPerMinute: "150" },
      });
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "anomaly",
        detail: expect.stringContaining("anomaly stop"),
      });
    });

    it("tracks anomaly spend per asset", async () => {
      const engine = createPolicyEngine({
        anomaly: { maxSpendPerMinute: "150" },
      });
      await engine.record(intent({ amount: "100", asset: "USDC:GA5Z" }));
      const result = await engine.check(intent({ amount: "100", asset: "EURC:GBBB" }));
      expect(result).toEqual({ allowed: true });
    });

    it("does not block during adaptive warm-up, then blocks a spike", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "2" },
              sensitivity: { numerator: "3", denominator: "1" },
              warmupPeriods: 2,
              scope: "asset",
            },
          },
        },
        { clock: () => now },
      );

      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      expect(await engine.check(intent({ amount: "1000" }))).toEqual({
        allowed: false,
        rule: "anomaly-adaptive",
        detail: expect.stringContaining("baseline 100"),
      });
    });

    it("caps baseline growth per completed minute", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "1" },
              sensitivity: { numerator: "3", denominator: "1" },
              warmupPeriods: 1,
              maxBaselineGrowthPerMinute: "10",
            },
          },
        },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "1000" }));
      now += 60_000;
      await engine.record(intent({ amount: "0" }));
      const trace = await engine.evaluate(intent({ amount: "1000" }));
      expect(trace.entries.find((entry) => entry.id === "anomaly-adaptive")?.detail).toContain(
        "baseline 110",
      );
    });

    it("isolates adaptive baselines by payee when configured", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "1" },
              sensitivity: { numerator: "1", denominator: "1" },
              warmupPeriods: 1,
              scope: "asset-payee",
            },
          },
        },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100", payee: "A" }));
      now += 60_000;
      await engine.record(intent({ amount: "100", payee: "A" }));
      expect(await engine.check(intent({ amount: "1000", payee: "B" }))).toEqual({ allowed: true });
    });

    it("reports an adaptive block through the anomaly callback", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const events: string[] = [];
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "1" },
              sensitivity: { numerator: "1", denominator: "1" },
              warmupPeriods: 1,
            },
          },
        },
        {
          clock: () => now,
          onAnomalyDetected: (event) => {
            events.push(event.detail);
          },
        },
      );
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await expect(engine.check(intent({ amount: "1000" }))).resolves.toMatchObject({
        allowed: false,
        rule: "anomaly-adaptive",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toContain("adaptive anomaly stop");
    });

    it("keeps a stationary stream below a generous sensitivity across seeds", async () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        let now = Date.parse("2026-06-10T12:00:00Z");
        const engine = createPolicyEngine(
          {
            anomaly: {
              adaptive: {
                kind: "ewma",
                smoothing: { numerator: "1", denominator: "2" },
                sensitivity: { numerator: "10", denominator: "1" },
                warmupPeriods: 2,
              },
            },
          },
          { clock: () => now },
        );
        const amount = 100 + (seed % 3);
        await engine.record(intent({ amount: String(amount) }));
        for (let minute = 1; minute < 8; minute += 1) {
          now += 60_000;
          expect((await engine.check(intent({ amount: String(amount) }))).allowed).toBe(true);
          await engine.record(intent({ amount: String(amount) }));
        }
      }
    });

    it("is monotone for larger spikes from the same learned state", async () => {
      const makeEngine = () => {
        let now = Date.parse("2026-06-10T12:00:00Z");
        const engine = createPolicyEngine(
          {
            anomaly: {
              adaptive: {
                kind: "ewma",
                smoothing: { numerator: "1", denominator: "2" },
                sensitivity: { numerator: "3", denominator: "1" },
                warmupPeriods: 2,
              },
            },
          },
          { clock: () => now },
        );
        return { engine, advance: () => (now += 60_000) };
      };
      const small = makeEngine();
      const large = makeEngine();
      for (const pair of [small, large]) {
        await pair.engine.record(intent({ amount: "100" }));
        pair.advance();
        await pair.engine.record(intent({ amount: "100" }));
        pair.advance();
        await pair.engine.record(intent({ amount: "100" }));
      }
      const smallDecision = await small.engine.check(intent({ amount: "150" }));
      const largeDecision = await large.engine.check(intent({ amount: "1000" }));
      expect(largeDecision.allowed).toBe(false);
      expect(smallDecision.allowed || !largeDecision.allowed).toBe(true);
    });
  });

  describe("invalid amount", () => {
    it("rejects a non-numeric amount", async () => {
      const engine = createPolicyEngine({});
      await expect(engine.check(intent({ amount: "abc" }))).rejects.toThrow(TollwayError);
    });

    it("rejects a decimal amount", async () => {
      const engine = createPolicyEngine({});
      await expect(engine.check(intent({ amount: "1.5" }))).rejects.toThrow(TollwayError);
    });

    it("rejects a negative amount", async () => {
      const engine = createPolicyEngine({});
      await expect(engine.check(intent({ amount: "-10" }))).rejects.toThrow(TollwayError);
    });

    it("uses the invalid-amount error code", async () => {
      const engine = createPolicyEngine({});
      try {
        await engine.check(intent({ amount: "abc" }));
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TollwayError);
        expect((e as TollwayError).code).toBe("invalid-amount");
      }
    });
  });

  describe("combined policies", () => {
    it("checks per-model before budget", async () => {
      const engine = createPolicyEngine({
        budgets: { daily: "50" },
        perModel: { "mpp-channel": { enabled: false } },
      });
      const result = await engine.check(intent({ model: "mpp-channel", amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-model-disabled",
        detail: expect.any(String),
      });
    });

    it("passes all rules when within all limits", async () => {
      const engine = createPolicyEngine({
        budgets: { daily: "1000", total: "5000" },
        perService: { GSERVICE: { cap: "500" } },
        perModel: { x402: { enabled: true } },
        rateLimit: { requestsPerMinute: 10 },
        anomaly: { maxSpendPerMinute: "2000" },
      });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });
  });

  describe("per-service daily cap (Issue #192)", () => {
    it("allows payments within the daily cap", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { dailyCap: "200" } },
      });
      expect(await engine.check(intent({ amount: "100" }))).toEqual({ allowed: true });
    });

    it("blocks when the per-service daily cap is exceeded", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { dailyCap: "150" } },
      });
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-service-daily",
        detail: expect.stringContaining("per-service daily cap exceeded"),
      });
    });

    it("resets on a new UTC day", async () => {
      let now = new Date("2026-06-10T12:00:00Z").getTime();
      const engine = createPolicyEngine(
        { perService: { GSERVICE: { dailyCap: "150" } } },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      expect(await engine.check(intent({ amount: "100" }))).toMatchObject({
        allowed: false,
        rule: "per-service-daily",
      });
      now = new Date("2026-06-11T00:01:00Z").getTime();
      expect(await engine.check(intent({ amount: "100" }))).toEqual({ allowed: true });
    });

    it("is isolated per (payee, asset)", async () => {
      const engine = createPolicyEngine({
        perService: {
          GSERVICE: { dailyCap: "150" },
          GOTHER: { dailyCap: "150" },
        },
      });
      await engine.record(intent({ amount: "100", payee: "GSERVICE", asset: "USDC:GA5Z" }));
      expect(
        await engine.check(intent({ amount: "100", payee: "GOTHER", asset: "USDC:GA5Z" })),
      ).toEqual({ allowed: true });
      expect(
        await engine.check(intent({ amount: "100", payee: "GSERVICE", asset: "EURC:GBBB" })),
      ).toEqual({ allowed: true });
    });
  });

  describe("per-service rolling-window cap (Issue #192)", () => {
    it("allows payments within the window cap", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { window: { windowSeconds: 3600, cap: "500" } } },
      });
      expect(await engine.check(intent({ amount: "100" }))).toEqual({ allowed: true });
    });

    it("blocks when the rolling-window sum exceeds the cap", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        { perService: { GSERVICE: { window: { windowSeconds: 3600, cap: "150" } } } },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      expect(await engine.check(intent({ amount: "100" }))).toMatchObject({
        allowed: false,
        rule: "per-service-window",
      });
    });

    it("recovers once older spend rolls out of the window", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        { perService: { GSERVICE: { window: { windowSeconds: 60, cap: "150" } } } },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      now += 65 * 1_000; // one bucket past the window
      // After enough buckets expire the earlier spend drops out and a
      // second payment is allowed again.
      now += 60 * 1_000;
      expect(await engine.check(intent({ amount: "100" }))).toEqual({ allowed: true });
    });

    it.each([
      [
        "a window of zero seconds",
        { perService: { GSERVICE: { window: { windowSeconds: 0, cap: "100" } } } },
        "perService.GSERVICE.window.windowSeconds",
      ],
      [
        // A fractional value would put a non-integer `seconds` in the trace,
        // which policyTraceSchema rejects.
        "a fractional window",
        { perService: { GSERVICE: { window: { windowSeconds: 90.5, cap: "100" } } } },
        "perService.GSERVICE.window.windowSeconds",
      ],
      [
        "a sub-second perResource window",
        {
          perResource: { "/api/": { match: "prefix", window: { windowSeconds: 1e-6, cap: "1" } } },
        },
        "perResource./api/.window.windowSeconds",
      ],
      [
        "a decimal perResource window cap",
        {
          perResource: { "/api/": { match: "prefix", window: { windowSeconds: 60, cap: "1.5" } } },
        },
        "perResource./api/.window.cap",
      ],
      [
        "a decimal daily cap",
        { perService: { GSERVICE: { dailyCap: "0.5" } } },
        "perService.GSERVICE.dailyCap",
      ],
      [
        "an unknown match kind",
        { perResource: { "/api/": { match: "glob", cap: "1" } } },
        "perResource./api/.match",
      ],
    ])("rejects %s when the engine is created, naming the field", (_name, input, path) => {
      let thrown: unknown;
      try {
        // Policies arrive as JSON, so the cases include values the type forbids.
        createPolicyEngine(input as unknown as PolicyInput);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PolicyValidationError);
      const issues = (thrown as PolicyValidationError).issues;
      expect(issues.map((issue) => issue.path.join("."))).toContain(path);
    });

    it("blocks a payment at the exact window boundary and allows it one bucket later", async () => {
      // The accumulator over-counts by at most one bucket, never under-counts.
      const start = Date.parse("2026-06-10T12:00:00Z");
      let now = start;
      const engine = createPolicyEngine(
        { perService: { GSERVICE: { window: { windowSeconds: 60, cap: "150" } } } },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      now = start + 59_999;
      expect(await engine.check(intent({ amount: "100" }))).toMatchObject({
        allowed: false,
        rule: "per-service-window",
      });
      now = start + 120_000;
      expect(await engine.check(intent({ amount: "100" }))).toEqual({ allowed: true });
    });
  });

  describe("per-resource caps (Issue #192)", () => {
    it("blocks on an exact-match lifetime cap", async () => {
      const engine = createPolicyEngine({
        perResource: { "/api/quotes": { cap: "150" } },
      });
      await engine.record(intent({ amount: "100" }));
      expect(await engine.check(intent({ amount: "100" }))).toMatchObject({
        allowed: false,
        rule: "per-resource",
      });
    });

    it("blocks on a daily cap and resets at UTC midnight", async () => {
      let now = new Date("2026-06-10T12:00:00Z").getTime();
      const engine = createPolicyEngine(
        { perResource: { "/api/quotes": { dailyCap: "150" } } },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      expect(await engine.check(intent({ amount: "100" }))).toMatchObject({
        allowed: false,
        rule: "per-resource-daily",
      });
      now = new Date("2026-06-11T00:01:00Z").getTime();
      expect(await engine.check(intent({ amount: "100" }))).toEqual({ allowed: true });
    });

    it("blocks on a rolling-window cap", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          perResource: {
            "/api/quotes": { window: { windowSeconds: 3600, cap: "150" } },
          },
        },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      expect(await engine.check(intent({ amount: "100" }))).toMatchObject({
        allowed: false,
        rule: "per-resource-window",
      });
    });

    it("longest-prefix wins among prefix entries", async () => {
      const engine = createPolicyEngine({
        perResource: {
          "/api/": { cap: "10000", match: "prefix" },
          "/api/quotes/": { cap: "150", match: "prefix" },
        },
      });
      await engine.record(intent({ resource: "/api/quotes/usd", amount: "100" }));
      const blocked = await engine.evaluate(intent({ resource: "/api/quotes/usd", amount: "100" }));
      expect(blocked.entries.find((e) => e.id === "per-resource")).toMatchObject({
        outcome: "fail",
        limit: "150",
      });
    });

    it("enforces a broader prefix cap that a narrower, looser prefix also matches", async () => {
      // The operator caps everything under /api/ at 150. A more specific
      // entry with a higher cap must not lift that ceiling.
      const engine = createPolicyEngine({
        perResource: {
          "/api/": { cap: "150", match: "prefix" },
          "/api/quotes/": { cap: "10000", match: "prefix" },
        },
      });
      await engine.record(intent({ resource: "/api/quotes/usd", amount: "100" }));
      const trace = await engine.evaluate(intent({ resource: "/api/quotes/usd", amount: "100" }));
      expect(trace.entries.find((e) => e.id === "per-resource")).toMatchObject({
        outcome: "fail",
        limit: "150",
        current: "100",
      });
    });

    it("charges every matching entry, so spend under one prefix counts toward the broader one", async () => {
      const engine = createPolicyEngine({
        perResource: {
          "/api/": { cap: "150", match: "prefix" },
          "/api/quotes/": { cap: "10000", match: "prefix" },
        },
      });
      await engine.record(intent({ resource: "/api/quotes/usd", amount: "100" }));
      // A different resource under /api/ sees the 100 already spent.
      expect(await engine.check(intent({ resource: "/api/other", amount: "100" }))).toMatchObject({
        allowed: false,
        rule: "per-resource",
      });
    });

    it("applies a prefix window to a resource that also has an exact entry", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          perResource: {
            "/api/": { match: "prefix", window: { windowSeconds: 3600, cap: "150" } },
            "/api/premium": { dailyCap: "100000" },
          },
        },
        { clock: () => now },
      );
      await engine.record(intent({ resource: "/api/premium", amount: "100" }));
      now += 60_000;
      expect(await engine.check(intent({ resource: "/api/premium", amount: "100" }))).toMatchObject(
        {
          allowed: false,
          rule: "per-resource-window",
        },
      );
    });

    it("reports the entry closest to its limit when every matching entry passes", async () => {
      const engine = createPolicyEngine({
        perResource: {
          "/api/": { cap: "1000", match: "prefix" },
          "/api/quotes": { cap: "300" },
        },
      });
      const trace = await engine.evaluate(intent({ resource: "/api/quotes", amount: "100" }));
      expect(trace.entries.find((e) => e.id === "per-resource")).toMatchObject({
        outcome: "pass",
        limit: "300",
      });
    });

    it("does not treat Object.prototype members as entries", async () => {
      const engine = createPolicyEngine({ perResource: { "/api/other": { cap: "100" } } });
      const trace = await engine.evaluate(intent({ resource: "constructor", amount: "100" }));
      expect(trace.entries.find((e) => e.id === "per-resource")).toMatchObject({
        outcome: "not-applicable",
        detail: "no perResource entry matches resource constructor",
      });
    });

    it("is not-applicable when no entry matches", async () => {
      const engine = createPolicyEngine({
        perResource: { "/api/other": { cap: "100" } },
      });
      const trace = await engine.evaluate(intent({ resource: "/api/quotes", amount: "100" }));
      expect(trace.entries.find((e) => e.id === "per-resource")).toMatchObject({
        outcome: "not-applicable",
      });
    });
  });
});
