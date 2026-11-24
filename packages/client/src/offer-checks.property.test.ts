/**
 * Property (#209): for random offers and random limits, runOfferChecks
 * accepts exactly the offers within every bound. The reference predicate is
 * written independently of the implementation, from the issue's rules.
 */

import type { PaymentOffer } from "@vegaforge/tollway-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type OfferChecks, OfferRejectedError, runOfferChecks } from "./offer-checks.js";

const RESOURCE = "https://api.example.com/data";
const ASSETS = ["CUSDC", "CXLM", "COTHER"] as const;
const PAYEES = ["GPAYEE1", "GPAYEE2", "GPAYEE3"] as const;

/** Integer strings in base units, from zero to past 2^64. */
const amount = fc.bigInt({ min: 0n, max: 2n ** 70n }).map((value) => value.toString());

const offer = fc.record({
  asset: fc.constantFrom(...ASSETS),
  payTo: fc.constantFrom(...PAYEES),
  amount,
});

const checks: fc.Arbitrary<OfferChecks> = fc.record(
  {
    maxAmount: fc.dictionary(fc.constantFrom(...ASSETS), amount, { maxKeys: ASSETS.length }),
    allowedPayees: fc.subarray([...PAYEES]),
    allowedAssets: fc.subarray([...ASSETS]),
    allowZeroAmount: fc.boolean(),
  },
  { requiredKeys: [] },
);

function shouldPass(candidate: PaymentOffer, limits: OfferChecks): boolean {
  const value = BigInt(candidate.amount);
  if (value === 0n && limits.allowZeroAmount !== true) return false;
  if (limits.allowedAssets && !limits.allowedAssets.includes(candidate.asset)) return false;
  if (limits.maxAmount) {
    const ceiling = Object.hasOwn(limits.maxAmount, candidate.asset)
      ? limits.maxAmount[candidate.asset]
      : undefined;
    if (ceiling === undefined || value > BigInt(ceiling)) return false;
  }
  if (limits.allowedPayees && !limits.allowedPayees.includes(candidate.payTo)) return false;
  return true;
}

function passes(candidate: PaymentOffer, limits: OfferChecks): boolean {
  try {
    runOfferChecks(candidate, RESOURCE, "testnet", limits);
    return true;
  } catch (error) {
    // Only a typed rejection counts as "refused"; anything else is a bug.
    if (error instanceof OfferRejectedError) return false;
    throw error;
  }
}

describe("property: runOfferChecks accepts exactly the offers within every bound", () => {
  it("matches the reference predicate", () => {
    fc.assert(
      fc.property(offer, checks, (terms, limits) => {
        const candidate: PaymentOffer = {
          ...terms,
          resource: RESOURCE,
          network: "testnet",
          models: ["x402"],
        };
        expect(passes(candidate, limits)).toBe(shouldPass(candidate, limits));
      }),
      { numRuns: 1000 },
    );
  });
});
