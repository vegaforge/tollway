import type { PaymentOffer } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "./facilitator.js";
import {
  assertPaywallValid,
  createFacilitatorValidator,
  describeMismatches,
  type FacilitatorCapabilities,
  type PaywallMismatch,
  parseFacilitatorCapabilities,
  validatePaywall,
} from "./facilitator-capabilities.js";

/**
 * Issue #155 coverage.
 *
 * The acceptance matrix is:
 * - `/supported` is schema-checked at the boundary and malformed bodies
 *   raise `TollwayError("payment-failed", ...)`.
 * - `validatePaywall` rejects EVM-only `exact`, old `x402Version`, a
 *   `stellar:*` wildcard is accepted, `CODE:ISSUER` asset is rejected,
 *   mismatched `extra.areFeesSponsored` is rejected.
 * - The validator wrapper caches `/supported`, respects `fail` / `warn`
 *   / `off` modes, and keeps serving on facilitator-unreachable errors
 *   in `warn` mode.
 */

const STELLAR_USDC_TESTNET_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const STELLAR_DESTINATION = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";

function makeOffer(overrides: Partial<PaymentOffer> = {}): PaymentOffer {
  return {
    resource: "https://api.example.com/quote",
    amount: "10000",
    asset: STELLAR_USDC_TESTNET_SAC,
    payTo: STELLAR_DESTINATION,
    network: "testnet",
    models: ["x402"],
    ...overrides,
  };
}

describe("parseFacilitatorCapabilities", () => {
  it("round-trips a well-formed response", () => {
    const raw = {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: ["offer-receipt"],
      signers: { "stellar:testnet": ["ed25519"] },
    };
    const parsed = parseFacilitatorCapabilities(raw);
    expect(parsed.kinds).toHaveLength(1);
    expect(parsed.kinds[0]).toEqual(raw.kinds[0]);
    expect(parsed.extensions).toEqual(["offer-receipt"]);
    expect(parsed.signers).toEqual({ "stellar:testnet": ["ed25519"] });
  });

  it("rejects a non-object response", () => {
    expect(() => parseFacilitatorCapabilities(null)).toThrow(TollwayError);
    expect(() => parseFacilitatorCapabilities("nope")).toThrow(TollwayError);
    expect(() => parseFacilitatorCapabilities(42)).toThrow(TollwayError);
  });

  it("rejects a response with no `kinds` array", () => {
    expect(() => parseFacilitatorCapabilities({ extensions: [] })).toThrow(/kinds/);
  });

  it("names the offending field on malformed kinds", () => {
    expect(() =>
      parseFacilitatorCapabilities({
        kinds: [{ x402Version: "two", scheme: "exact", network: "stellar:testnet" }],
      }),
    ).toThrow(/kinds\[0\]\.x402Version/);

    expect(() =>
      parseFacilitatorCapabilities({
        kinds: [{ x402Version: 2, scheme: "", network: "stellar:testnet" }],
      }),
    ).toThrow(/kinds\[0\]\.scheme/);

    expect(() =>
      parseFacilitatorCapabilities({
        kinds: [{ x402Version: 2, scheme: "exact", network: 7 }],
      }),
    ).toThrow(/kinds\[0\]\.network/);

    expect(() =>
      parseFacilitatorCapabilities({
        kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: "no" }],
      }),
    ).toThrow(/kinds\[0\]\.extra/);
  });

  it("treats a missing `extensions` field as empty but rejects a non-array", () => {
    expect(parseFacilitatorCapabilities({ kinds: [] }).extensions).toEqual([]);
    expect(() => parseFacilitatorCapabilities({ kinds: [], extensions: "no" })).toThrow(
      /extensions/,
    );
  });

  it("rejects a non-object `signers`", () => {
    expect(() => parseFacilitatorCapabilities({ kinds: [], signers: "no" })).toThrow(/signers/);
  });
});

describe("validatePaywall", () => {
  const offer = makeOffer();

  it("accepts the testnet CAIP-2 kind", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
      signers: {},
    };
    expect(validatePaywall(offer, caps)).toEqual({ valid: true });
  });

  it("accepts the stellar:* wildcard", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:*" }],
      extensions: [],
      signers: {},
    };
    expect(validatePaywall(offer, caps)).toEqual({ valid: true });
  });

  it("rejects an EVM-only facilitator for a Stellar paywall", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:1" }],
      extensions: [],
      signers: {},
    };
    const result = validatePaywall(offer, caps);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; mismatches: PaywallMismatch[] }).mismatches).toContainEqual(
      expect.objectContaining({ field: "network", advertised: "eip155:1" }),
    );
  });

  it("rejects an advertised x402Version other than 2", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [{ x402Version: 1, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
      signers: {},
    };
    const result = validatePaywall(offer, caps);
    expect(result.valid).toBe(false);
    expect(
      (result as { valid: false; mismatches: PaywallMismatch[] }).mismatches.map(
        (mismatch) => mismatch.field,
      ),
    ).toContain("x402Version");
  });

  it("rejects the CODE:ISSUER asset form documented in the mock demo", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
      signers: {},
    };
    const result = validatePaywall(makeOffer({ asset: "USDC:GCKFB..." }), caps);
    expect(result.valid).toBe(false);
    expect(
      (result as { valid: false; mismatches: PaywallMismatch[] }).mismatches.map(
        (mismatch) => mismatch.field,
      ),
    ).toContain("asset");
  });

  it("rejects an invalid payTo", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
      signers: {},
    };
    const result = validatePaywall(makeOffer({ payTo: "not-a-stellar-address" }), caps);
    expect(result.valid).toBe(false);
    expect(
      (result as { valid: false; mismatches: PaywallMismatch[] }).mismatches.map(
        (mismatch) => mismatch.field,
      ),
    ).toContain("payTo");
  });

  it("rejects a mismatched areFeesSponsored when the caller supplies the expectation", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          extra: { areFeesSponsored: false },
        },
      ],
      extensions: [],
      signers: {},
    };
    const result = validatePaywall(offer, caps, { expectedFeesSponsored: true });
    expect(result.valid).toBe(false);
    expect(
      (result as { valid: false; mismatches: PaywallMismatch[] }).mismatches.map(
        (mismatch) => mismatch.field,
      ),
    ).toContain("extra.areFeesSponsored");
  });
});

describe("createFacilitatorValidator", () => {
  function fixture() {
    const supportedFn = vi.fn<() => Promise<FacilitatorCapabilities>>();
    let currentMs = 1_000;
    const client: FacilitatorClient = {
      verify: async () => ({ valid: false, reason: "unused" }),
      settle: async () => ({ settled: false, reason: "unused" }),
      supported: supportedFn,
    };
    return {
      client,
      supportedFn,
      advance(deltaMs: number) {
        currentMs += deltaMs;
      },
      clock: () => currentMs,
    };
  }

  const matchingCaps: FacilitatorCapabilities = {
    kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:*" }],
    extensions: [],
    signers: {},
  };

  const mismatchingCaps: FacilitatorCapabilities = {
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:1" }],
    extensions: [],
    signers: {},
  };

  it("caches /supported for the TTL and refreshes afterwards", async () => {
    const { client, supportedFn, advance, clock } = fixture();
    supportedFn.mockResolvedValue(matchingCaps);
    const validator = createFacilitatorValidator(client, {
      mode: "fail",
      ttlMs: 10_000,
      clock,
    });
    await validator.validate(makeOffer());
    await validator.validate(makeOffer());
    advance(5_000);
    await validator.validate(makeOffer());
    expect(supportedFn).toHaveBeenCalledTimes(1);

    advance(6_000);
    await validator.validate(makeOffer());
    expect(supportedFn).toHaveBeenCalledTimes(2);
  });

  it("in fail mode propagates a facilitator error so boot aborts", async () => {
    const { client, supportedFn } = fixture();
    supportedFn.mockRejectedValue(new TollwayError("payment-failed", "unreachable"));
    const validator = createFacilitatorValidator(client, { mode: "fail", ttlMs: 10_000 });
    await expect(validator.validate(makeOffer())).rejects.toThrow(TollwayError);
  });

  it("in warn mode reports facilitator-unreachable through the callback and keeps serving", async () => {
    const { client, supportedFn } = fixture();
    supportedFn.mockRejectedValue(new TollwayError("payment-failed", "unreachable"));
    const warnings: PaywallMismatch[][] = [];
    const validator = createFacilitatorValidator(client, {
      mode: "warn",
      ttlMs: 10_000,
      onWarn: (mismatches) => warnings.push(mismatches),
    });
    const result = await validator.validate(makeOffer());
    expect(result).toEqual({ valid: true });
    expect(warnings).toHaveLength(1);
    const first = warnings[0]?.[0];
    expect(first?.advertised).toMatch(/unreachable/);
  });

  it("in off mode short-circuits every call to valid", async () => {
    const { client, supportedFn } = fixture();
    supportedFn.mockResolvedValue(mismatchingCaps);
    const validator = createFacilitatorValidator(client, { mode: "off", ttlMs: 10_000 });
    const result = await validator.validate(makeOffer());
    expect(result).toEqual({ valid: true });
    expect(supportedFn).not.toHaveBeenCalled();
  });

  it("in warn mode invokes onWarn once per mismatching paywall and keeps serving", async () => {
    const { client, supportedFn } = fixture();
    supportedFn.mockResolvedValue(mismatchingCaps);
    const warnings: PaywallMismatch[][] = [];
    const validator = createFacilitatorValidator(client, {
      mode: "warn",
      ttlMs: 10_000,
      onWarn: (mismatches) => warnings.push(mismatches),
    });
    const result = await validator.validate(makeOffer());
    expect(result.valid).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContainEqual(
      expect.objectContaining({ field: "network", advertised: "eip155:1" }),
    );
  });

  it("refresh() clears the cache so the next call re-fetches", async () => {
    const { client, supportedFn, clock } = fixture();
    supportedFn.mockResolvedValue(matchingCaps);
    const validator = createFacilitatorValidator(client, {
      mode: "fail",
      ttlMs: 60_000,
      clock,
    });
    await validator.validate(makeOffer());
    expect(supportedFn).toHaveBeenCalledTimes(1);
    await validator.refresh();
    expect(supportedFn).toHaveBeenCalledTimes(2);
  });
});

describe("assertPaywallValid / describeMismatches", () => {
  it("throws with every mismatch enumerated in the message", () => {
    const caps: FacilitatorCapabilities = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:1" }],
      extensions: [],
      signers: {},
    };
    try {
      assertPaywallValid(makeOffer({ asset: "USDC:GCKFB..." }), caps);
      throw new Error("expected assertPaywallValid to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TollwayError);
      const message = (error as TollwayError).message;
      expect(message).toMatch(/field=network/);
      expect(message).toMatch(/field=asset/);
    }
  });

  it("describes nothing when the paywall is valid", () => {
    expect(describeMismatches([])).toBe("");
  });
});
