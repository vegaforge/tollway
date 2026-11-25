import { describe, expect, it } from "vitest";
import type { PaymentIntent, PolicyEngine, PolicyReservation } from "./policy.js";
import { createPolicyEngine, PolicyReservationError } from "./policy.js";

/**
 * Reservations (#189) hold a payment's spend against every budget and window
 * until it is committed or released, so payments in flight at the same time
 * cannot all pass the same budget.
 */

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    payee: "GPAYEE",
    resource: "/quote",
    amount: "100",
    asset: "USDC",
    model: "x402",
    ...overrides,
  };
}

/** `reserve` is optional on the interface; the engine under test implements it. */
function reserveOn(engine: PolicyEngine, payment: PaymentIntent) {
  if (engine.reserve === undefined) throw new Error("expected the engine to implement reserve");
  return engine.reserve(payment);
}

function reservedOf(value: PolicyReservation | undefined): PolicyReservation {
  if (value === undefined) throw new Error("expected a reservation");
  return value;
}

describe("PolicyEngine.reserve", () => {
  it("counts a held payment against the daily budget before it is committed", async () => {
    const engine = createPolicyEngine({ budgets: { daily: "150" } });

    const first = await reserveOn(engine, intent({ amount: "100" }));
    const second = await reserveOn(engine, intent({ amount: "100" }));

    expect(first.reservation).toBeDefined();
    expect(second.reservation).toBeUndefined();
    expect(second.trace.allowed).toBe(false);
    expect(second.trace.blockedBy).toBe("budget-daily");
  });

  it("gives the spend back at once when a held payment is released", async () => {
    const engine = createPolicyEngine({ budgets: { daily: "150" } });
    const held = reservedOf((await reserveOn(engine, intent({ amount: "100" }))).reservation);

    await engine.release?.(held);

    const again = await reserveOn(engine, intent({ amount: "100" }));
    expect(again.reservation).toBeDefined();
  });

  it("keeps the spend when a held payment is committed", async () => {
    const engine = createPolicyEngine({ budgets: { daily: "150" } });
    const held = reservedOf((await reserveOn(engine, intent({ amount: "100" }))).reservation);

    await engine.commit?.(held);

    const after = await reserveOn(engine, intent({ amount: "100" }));
    expect(after.reservation).toBeUndefined();
  });

  it("counts a held payment against a per-service cap", async () => {
    const engine = createPolicyEngine({ perService: { GPAYEE: { cap: "150" } } });

    await reserveOn(engine, intent({ amount: "100" }));
    const second = await reserveOn(engine, intent({ amount: "100" }));

    expect(second.trace.allowed).toBe(false);
    expect(second.trace.blockedBy).toBe("per-service");
  });

  it("holds nothing for a payment the trace blocks", async () => {
    const engine = createPolicyEngine({ budgets: { daily: "50" } });

    const blocked = await reserveOn(engine, intent({ amount: "100" }));

    expect(blocked.reservation).toBeUndefined();
    expect((await engine.check(intent({ amount: "50" }))).allowed).toBe(true);
  });
});

describe("PolicyEngine.commit and release", () => {
  it("treats a repeated commit or release of the same state as a no-op", async () => {
    const engine = createPolicyEngine({ budgets: { daily: "150" } });
    const held = reservedOf((await reserveOn(engine, intent())).reservation);

    await engine.release?.(held);
    await engine.release?.(held);
    const committed = reservedOf((await reserveOn(engine, intent())).reservation);
    await engine.commit?.(committed);
    await engine.commit?.(committed);

    expect((await reserveOn(engine, intent())).reservation).toBeUndefined();
  });

  it("refuses to release a committed reservation", async () => {
    const engine = createPolicyEngine({ budgets: { daily: "150" } });
    const held = reservedOf((await reserveOn(engine, intent())).reservation);
    await engine.commit?.(held);

    await expect(engine.release?.(held)).rejects.toBeInstanceOf(PolicyReservationError);
  });

  it("refuses to commit a released reservation rather than doing nothing", async () => {
    const engine = createPolicyEngine({ budgets: { daily: "150" } });
    const held = reservedOf((await reserveOn(engine, intent())).reservation);
    await engine.release?.(held);

    await expect(engine.commit?.(held)).rejects.toBeInstanceOf(PolicyReservationError);
  });

  it("refuses a reservation issued by another engine", async () => {
    const first = createPolicyEngine({ budgets: { daily: "150" } });
    const second = createPolicyEngine({ budgets: { daily: "150" } });
    const held = reservedOf((await reserveOn(first, intent())).reservation);

    await expect(second.commit?.(held)).rejects.toBeInstanceOf(PolicyReservationError);
    await expect(second.release?.(held)).rejects.toBeInstanceOf(PolicyReservationError);
  });
});

describe("reservation expiry", () => {
  it("releases a hold that is never committed once its time to live has passed", async () => {
    let now = new Date("2026-06-10T00:00:00Z").getTime();
    const expired: string[] = [];
    const engine = createPolicyEngine(
      { budgets: { daily: "150" } },
      {
        clock: () => now,
        reservationTtlMs: 1_000,
        onReservationExpired: (reservation) => expired.push(reservation.id),
      },
    );
    const held = reservedOf((await reserveOn(engine, intent())).reservation);

    now += 1_001;

    expect((await reserveOn(engine, intent())).reservation).toBeDefined();
    expect(expired).toEqual([held.id]);
  });

  it("counts a payment again when it is committed after its hold lapsed", async () => {
    // The payment may already have settled, so its spend must not be dropped.
    let now = new Date("2026-06-10T00:00:00Z").getTime();
    const engine = createPolicyEngine(
      { budgets: { daily: "150" } },
      { clock: () => now, reservationTtlMs: 1_000 },
    );
    const held = reservedOf((await reserveOn(engine, intent())).reservation);

    now += 1_001;
    await engine.check(intent());
    await engine.commit?.(held);

    expect((await reserveOn(engine, intent())).trace.allowed).toBe(false);
  });
});
