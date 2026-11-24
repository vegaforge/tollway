import { TollwayError } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { type SizeDepositInput, sizeDeposit } from "./sizing.js";

// #181: deposit sizing. The function is pure, so each case lists every input.
// Price 10 at 6 requests a minute for an hour is 360 requests, so demand is 3600.

const BASE: SizeDepositInput = {
  pricePerRequest: "10",
  traffic: { requestsPerMinute: 6, windowSeconds: 60 },
  horizonSeconds: 3600,
  safetyFactorBps: 10_000,
  minDeposit: "0",
  headroom: null,
};

function sized(overrides: Partial<SizeDepositInput>) {
  return sizeDeposit({ ...BASE, ...overrides });
}

/** The error a call throws. Fails the test if the call returns instead. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("sizeDeposit", () => {
  it("sizes the deposit to predicted demand over the horizon", () => {
    expect(sized({})).toMatchObject({ open: true, deposit: "3600" });
  });

  it("applies the safety factor in basis points", () => {
    expect(sized({ safetyFactorBps: 12_000 })).toMatchObject({ open: true, deposit: "4320" });
  });

  it("rounds demand up, so the deposit never undershoots it", () => {
    // Demand is 1 × 0.5 × 1 / 60 = 0.0083, which rounds up to 1.
    const result = sized({
      pricePerRequest: "1",
      traffic: { requestsPerMinute: 0.5, windowSeconds: 60 },
      horizonSeconds: 1,
    });
    expect(result).toMatchObject({ open: true, deposit: "1" });
  });

  it("raises a deposit below the minimum to the minimum", () => {
    const result = sized({
      pricePerRequest: "1",
      traffic: { requestsPerMinute: 0.5, windowSeconds: 60 },
      horizonSeconds: 1,
      minDeposit: "1000",
    });
    expect(result).toMatchObject({ open: true, deposit: "1000" });
  });

  it("caps the deposit at the maximum", () => {
    expect(sized({ maximum: "2000" })).toMatchObject({ open: true, deposit: "2000" });
  });

  it("caps the deposit at the headroom when the headroom is tighter", () => {
    expect(sized({ headroom: "2500" })).toMatchObject({ open: true, deposit: "2500" });
  });

  it("uses the maximum when it is tighter than the headroom", () => {
    expect(sized({ maximum: "2000", headroom: "2500" })).toMatchObject({
      open: true,
      deposit: "2000",
    });
  });

  it("does not open when the headroom is below the minimum, and says why", () => {
    expect(sized({ headroom: "40000", minDeposit: "100000" })).toEqual({
      open: false,
      reason: "headroom 40000 below minimum deposit 100000",
    });
  });

  it("names the maximum, not the headroom, when the maximum is the tighter cap", () => {
    const result = sized({ maximum: "0", minDeposit: "0", headroom: "9000" });
    expect(result).toEqual({ open: false, reason: "maximum 0 below minimum deposit 1" });
  });

  it("does not open when there is no predicted demand", () => {
    expect(sized({ traffic: { requestsPerMinute: 0, windowSeconds: 60 } })).toMatchObject({
      open: false,
    });
  });

  it("does not open when the price is zero", () => {
    expect(sized({ pricePerRequest: "0" })).toMatchObject({ open: false });
  });

  it("does not open when the headroom leaves no room for a positive deposit", () => {
    expect(sized({ headroom: "0" })).toMatchObject({ open: false });
  });

  it("rounds requests per minute to a millionth, so a tiny rate has no demand", () => {
    const result = sized({ traffic: { requestsPerMinute: 0.0000004, windowSeconds: 60 } });
    expect(result).toMatchObject({ open: false });
  });

  it("keeps a very large price exact", () => {
    const max = ((1n << 127n) - 1n).toString();
    const result = sized({
      pricePerRequest: max,
      traffic: { requestsPerMinute: 1, windowSeconds: 60 },
      horizonSeconds: 60,
    });
    expect(result).toMatchObject({ open: true, deposit: max });
  });

  it("rejects a maximum below the minimum deposit as a configuration error", () => {
    const error = thrownBy(() => sized({ maximum: "5", minDeposit: "10" }));
    expect(error).toBeInstanceOf(TollwayError);
    expect(error).toMatchObject({ code: "invalid-policy" });
  });

  it("rejects an amount that is not an integer string", () => {
    expect(thrownBy(() => sized({ pricePerRequest: "1.5" }))).toMatchObject({
      code: "invalid-amount",
    });
  });

  it("rejects a horizon that is not a positive integer", () => {
    expect(thrownBy(() => sized({ horizonSeconds: 1.5 }))).toMatchObject({
      code: "invalid-policy",
    });
    expect(() => sized({ horizonSeconds: 0 })).toThrow(TollwayError);
  });

  it("rejects a safety factor below one whole", () => {
    expect(() => sized({ safetyFactorBps: 9_999 })).toThrow(TollwayError);
  });

  it("rejects a negative or non-finite request rate", () => {
    expect(() => sized({ traffic: { requestsPerMinute: -1, windowSeconds: 60 } })).toThrow(
      TollwayError,
    );
    expect(() => sized({ traffic: { requestsPerMinute: Number.NaN, windowSeconds: 60 } })).toThrow(
      TollwayError,
    );
  });
});

describe("sizeDeposit properties", () => {
  // A seeded run, so a failure can be replayed. Every case checks the bounds,
  // and that a higher rate never sizes a smaller deposit.
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  it("keeps every open deposit within bounds and monotonic in the request rate", () => {
    const random = seeded(181);
    const pick = (max: number): number => Math.floor(random() * max);

    for (let i = 0; i < 300; i += 1) {
      const price = String(1 + pick(100_000));
      const minDeposit = String(pick(5_000));
      const maximum = random() < 0.5 ? String(Number(minDeposit) + pick(500_000)) : undefined;
      const headroom = random() < 0.5 ? String(pick(1_000_000)) : null;
      const horizonSeconds = 1 + pick(7_200);
      const safetyFactorBps = 10_000 + pick(20_000);
      const rate = random() * 120;

      const base = {
        pricePerRequest: price,
        horizonSeconds,
        safetyFactorBps,
        minDeposit,
        headroom,
        ...(maximum === undefined ? {} : { maximum }),
      };
      const low = sizeDeposit({ ...base, traffic: { requestsPerMinute: rate, windowSeconds: 60 } });
      const high = sizeDeposit({
        ...base,
        traffic: { requestsPerMinute: rate * 2 + 1, windowSeconds: 60 },
      });

      for (const decision of [low, high]) {
        if (!decision.open) continue;
        const deposit = BigInt(decision.deposit);
        expect(deposit >= BigInt(minDeposit) && deposit >= 1n).toBe(true);
        if (maximum !== undefined) expect(deposit <= BigInt(maximum)).toBe(true);
        if (headroom !== null) expect(deposit <= BigInt(headroom)).toBe(true);
      }
      if (low.open && high.open) {
        expect(BigInt(high.deposit) >= BigInt(low.deposit)).toBe(true);
      }
    }
  });
});
