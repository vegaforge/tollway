import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, type PaymentIntent, type Policy } from "./policy.js";
import { type SettlementModel, settlementModels } from "./types.js";

/** Pinned seed so a CI failure replays exactly, as in reconcile.property.test.ts. */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

// The ceilings sit below what the per-service caps allow together, and one
// payee has no cap, so every ceiling can be the one that blocks. A limit no
// sequence can reach would let a broken check pass.
const DAILY_LIMIT = 1_500n;
const TOTAL_LIMIT = 2_000n;
const SERVICE_CAP = 600n;
const REQUESTS_PER_MINUTE = 3;
const WINDOW_MS = 60_000;
const START_MS = Date.parse("2026-06-10T20:00:00Z");

const CAPPED_PAYEES = ["svc-a", "svc-b", "svc-c"] as const;
const PAYEES = [...CAPPED_PAYEES, "svc-uncapped"] as const;
const ASSETS = ["USDC:GA5Z", "EURC:GBBB"] as const;

const POLICY: Policy = {
  policyVersion: 1,
  budgets: { daily: DAILY_LIMIT.toString(), total: TOTAL_LIMIT.toString() },
  perService: Object.fromEntries(
    CAPPED_PAYEES.map((payee) => [payee, { cap: SERVICE_CAP.toString() }]),
  ),
  rateLimit: { requestsPerMinute: REQUESTS_PER_MINUTE },
};

const TEXT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_-";

function textArb(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...TEXT_CHARS.split("")), { minLength, maxLength })
    .map((letters) => letters.join(""));
}

const amountArb = fc
  .oneof(
    fc.bigInt({ min: 0n, max: 300n }),
    fc.bigInt({ min: 300n, max: 1_600n }),
    fc.constantFrom(599n, 600n, 601n, 1_499n, 1_500n, 1_501n, 1_999n, 2_000n, 2_001n),
  )
  .map(String);

type Step = {
  amount: string;
  payee: string;
  asset: string;
  model: SettlementModel;
  resource: string;
  stepMs: number;
};

const stepArb: fc.Arbitrary<Step> = fc.record({
  amount: amountArb,
  payee: fc.constantFrom(...PAYEES),
  asset: fc.constantFrom(...ASSETS),
  model: fc.constantFrom(...settlementModels),
  resource: textArb(1, 12),
  // Short steps fill the one-minute rate window; six hours can cross a UTC
  // midnight, which exercises the daily reset.
  stepMs: fc.oneof(
    fc.integer({ min: 0, max: 30_000 }),
    fc.integer({ min: 0, max: 6 * 60 * 60 * 1000 }),
  ),
});

function intentFor(step: Step): PaymentIntent {
  return {
    payee: step.payee,
    resource: step.resource,
    amount: step.amount,
    asset: step.asset,
    model: step.model,
  };
}

function serviceCap(payee: string): bigint | null {
  return (CAPPED_PAYEES as readonly string[]).includes(payee) ? SERVICE_CAP : null;
}

function serviceKey(payee: string, asset: string): string {
  return `${payee}:${asset}`;
}

function utcDay(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/** Independent reference model: plain bigint sums, never the engine's code. */
type ReferenceState = {
  day: string;
  daily: Map<string, bigint>;
  total: Map<string, bigint>;
  service: Map<string, bigint>;
  allowedChecks: number[];
};

function pruneWindow(timestamps: number[], now: number): void {
  const cutoff = now - WINDOW_MS;
  while (timestamps[0] !== undefined && timestamps[0] < cutoff) {
    timestamps.shift();
  }
}

function traceCurrent(
  trace: Awaited<ReturnType<ReturnType<typeof createPolicyEngine>["evaluate"]>>,
  id: string,
): string | null {
  return trace.entries.find((entry) => entry.id === id)?.current ?? null;
}

const CEILINGS = ["budget-daily", "budget-total", "per-service", "rate-limit"] as const;

describe("createPolicyEngine invariants", () => {
  it("never exceeds daily, total, per-service or rate ceilings over arbitrary sequences", async () => {
    // Which ceiling blocked, across every run: the property only means
    // something if each one actually blocks a payment at least once.
    const blockedBy = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { maxLength: 24 }), async (steps) => {
        let now = START_MS;
        const engine = createPolicyEngine(POLICY, { clock: () => now });
        const reference: ReferenceState = {
          day: utcDay(now),
          daily: new Map(),
          total: new Map(),
          service: new Map(),
          allowedChecks: [],
        };

        for (const step of steps) {
          now += step.stepMs;
          const day = utcDay(now);
          if (day !== reference.day) {
            reference.daily.clear();
            reference.day = day;
          }
          pruneWindow(reference.allowedChecks, now);

          const intent = intentFor(step);
          const amount = BigInt(step.amount);
          const service = serviceKey(intent.payee, intent.asset);
          const cap = serviceCap(intent.payee);
          const before = await engine.evaluate(intent);
          const decision = await engine.check(intent);
          if (!decision.allowed && before.blockedBy) blockedBy.add(before.blockedBy);

          const expectedAllowed =
            (reference.daily.get(intent.asset) ?? 0n) + amount <= DAILY_LIMIT &&
            (reference.total.get(intent.asset) ?? 0n) + amount <= TOTAL_LIMIT &&
            (cap === null || (reference.service.get(service) ?? 0n) + amount <= cap) &&
            reference.allowedChecks.length + 1 <= REQUESTS_PER_MINUTE;
          expect(decision.allowed).toBe(expectedAllowed);

          if (expectedAllowed) {
            reference.allowedChecks.push(now);
            await engine.record(intent);
            reference.daily.set(intent.asset, (reference.daily.get(intent.asset) ?? 0n) + amount);
            reference.total.set(intent.asset, (reference.total.get(intent.asset) ?? 0n) + amount);
            reference.service.set(service, (reference.service.get(service) ?? 0n) + amount);
          }

          // The engine's own counters, read after every step whether or not
          // it paid: they match the reference and never pass a ceiling.
          const trace = await engine.evaluate(intent);
          const daily = BigInt(traceCurrent(trace, "budget-daily") ?? "0");
          const total = BigInt(traceCurrent(trace, "budget-total") ?? "0");
          expect(daily).toBe(reference.daily.get(intent.asset) ?? 0n);
          expect(total).toBe(reference.total.get(intent.asset) ?? 0n);
          expect(daily).toBeLessThanOrEqual(DAILY_LIMIT);
          expect(total).toBeLessThanOrEqual(TOTAL_LIMIT);
          if (cap !== null) {
            const spent = BigInt(traceCurrent(trace, "per-service") ?? "0");
            expect(spent).toBe(reference.service.get(service) ?? 0n);
            expect(spent).toBeLessThanOrEqual(cap);
          }
          const requests = Number(traceCurrent(trace, "rate-limit") ?? "0");
          expect(requests).toBe(reference.allowedChecks.length);
          expect(requests).toBeLessThanOrEqual(REQUESTS_PER_MINUTE);
        }
      }),
      ASSERT_OPTS,
    );
    expect([...blockedBy].sort()).toEqual([...CEILINGS].sort());
  });

  it("never changes a later decision just because check was called extra times", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { maxLength: 8 }), async (steps) => {
        let now = START_MS;
        const once = createPolicyEngine(POLICY, { clock: () => now });
        const extraChecks = createPolicyEngine(POLICY, { clock: () => now });

        for (const step of steps) {
          now += step.stepMs;
          const intent = intentFor(step);
          const baseline = await once.check(intent);
          const repeatedFirst = await extraChecks.check(intent);
          await extraChecks.check(intent);
          await extraChecks.check(intent);
          const repeatedLast = await extraChecks.check(intent);

          expect(repeatedFirst).toEqual(baseline);
          expect(repeatedLast).toEqual(baseline);

          if (baseline.allowed) {
            await once.record(intent);
            await extraChecks.record(intent);
          }
        }
      }),
      ASSERT_OPTS,
    );
  });
});
