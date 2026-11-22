import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, type PaymentIntent, type Policy } from "./policy.js";
import { type SettlementModel, settlementModels } from "./types.js";

/** Pinned seed so a CI failure replays exactly, as in reconcile.property.test.ts. */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

const DAILY_LIMIT = 10_000n;
const TOTAL_LIMIT = 50_000n;
const SERVICE_CAP = 2_000n;
const REQUESTS_PER_MINUTE = 3;
const WINDOW_MS = 60_000;
const START_MS = Date.parse("2026-06-10T20:00:00Z");

const PAYEES = ["svc-a", "svc-b", "svc-c"] as const;
const ASSETS = ["USDC:GA5Z", "EURC:GBBB"] as const;

const POLICY: Policy = {
  budgets: { daily: DAILY_LIMIT.toString(), total: TOTAL_LIMIT.toString() },
  perService: Object.fromEntries(PAYEES.map((payee) => [payee, { cap: SERVICE_CAP.toString() }])),
  rateLimit: { requestsPerMinute: REQUESTS_PER_MINUTE },
};

const TEXT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_-";

function textArb(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...TEXT_CHARS.split("")), { minLength, maxLength })
    .map((letters) => letters.join(""));
}

const amountArb = fc
  .oneof(fc.bigInt({ min: 0n, max: 300n }), fc.constantFrom(1_999n, 2_000n, 2_001n))
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
  // Six hours can cross a UTC midnight, which exercises the daily reset.
  stepMs: fc.integer({ min: 0, max: 6 * 60 * 60 * 1000 }),
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

describe("createPolicyEngine invariants", () => {
  it("never exceeds daily, total, per-service or rate ceilings over arbitrary sequences", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { maxLength: 18 }), async (steps) => {
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
          const decision = await engine.check(intent);

          const expectedAllowed =
            (reference.daily.get(intent.asset) ?? 0n) + amount <= DAILY_LIMIT &&
            (reference.total.get(intent.asset) ?? 0n) + amount <= TOTAL_LIMIT &&
            (reference.service.get(service) ?? 0n) + amount <= SERVICE_CAP &&
            reference.allowedChecks.length + 1 <= REQUESTS_PER_MINUTE;
          expect(decision.allowed).toBe(expectedAllowed);

          if (expectedAllowed) {
            reference.allowedChecks.push(now);
            await engine.record(intent);
            reference.daily.set(intent.asset, (reference.daily.get(intent.asset) ?? 0n) + amount);
            reference.total.set(intent.asset, (reference.total.get(intent.asset) ?? 0n) + amount);
            reference.service.set(service, (reference.service.get(service) ?? 0n) + amount);

            const trace = await engine.evaluate(intent);
            expect(traceCurrent(trace, "budget-daily")).toBe(
              (reference.daily.get(intent.asset) ?? 0n).toString(),
            );
            expect(traceCurrent(trace, "budget-total")).toBe(
              (reference.total.get(intent.asset) ?? 0n).toString(),
            );
            expect(traceCurrent(trace, "per-service")).toBe(
              (reference.service.get(service) ?? 0n).toString(),
            );
            expect(traceCurrent(trace, "rate-limit")).toBe(
              reference.allowedChecks.length.toString(),
            );
          }

          expect(reference.daily.get(intent.asset) ?? 0n).toBeLessThanOrEqual(DAILY_LIMIT);
          expect(reference.total.get(intent.asset) ?? 0n).toBeLessThanOrEqual(TOTAL_LIMIT);
          expect(reference.service.get(service) ?? 0n).toBeLessThanOrEqual(SERVICE_CAP);
          expect(reference.allowedChecks.length).toBeLessThanOrEqual(REQUESTS_PER_MINUTE);
        }
      }),
      ASSERT_OPTS,
    );
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
