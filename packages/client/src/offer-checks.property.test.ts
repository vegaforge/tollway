/**
 * Property test: for random offers and random limits, runOfferChecks accepts
 * exactly the offers within every bound.
 *
 * We use a hand-rolled generator rather than a property-testing library to
 * avoid adding a dev dependency. The test generates 500 random (offer, checks)
 * pairs and asserts that the check outcome matches the expected outcome
 * computed independently from the same inputs. Any counterexample is printed.
 */

import type { PaymentOffer } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { type OfferChecks, OfferRejectedError, runOfferChecks } from "./offer-checks.js";

// ---------------------------------------------------------------------------
// Minimal LCG-based PRNG (deterministic, seeded)
// ---------------------------------------------------------------------------

function makePrng(seed: number) {
  let state = seed >>> 0;
  return function next(): number {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Random generation helpers
// ---------------------------------------------------------------------------

const ASSETS = [
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "CXLM0000000000000000000000000000000000000000000000000000AB",
  "COTHER00000000000000000000000000000000000000000000000000CC",
];
const PAYEES = [
  "GCPAYEE1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "GCPAYEE2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "GCPAYEE3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
];
const RESOURCE = "https://api.example.com/data";

function randomOffer(rand: () => number): PaymentOffer {
  const asset = ASSETS[Math.floor(rand() * ASSETS.length)] ?? ASSETS[0]!;
  const payee = PAYEES[Math.floor(rand() * PAYEES.length)] ?? PAYEES[0]!;
  // Amounts 1–1_000_000_000 to keep them non-zero and representable.
  const amount = String(Math.max(1, Math.floor(rand() * 1_000_000_000)));
  return {
    resource: RESOURCE,
    amount,
    asset,
    payTo: payee,
    network: "testnet",
    models: ["x402"],
  };
}

function randomChecks(rand: () => number): OfferChecks {
  const hasMaxAmount = rand() < 0.6;
  const hasAllowedPayees = rand() < 0.5;
  const hasAllowedAssets = rand() < 0.5;

  const maxAmount: Record<string, string> | undefined = hasMaxAmount
    ? Object.fromEntries(
        ASSETS.map((a) => {
          // Some assets present (randomly), giving 0–3 entries.
          if (rand() < 0.7) {
            return [a, String(Math.max(1, Math.floor(rand() * 1_000_000_000)))];
          }
          return null;
        }).filter((e): e is [string, string] => e !== null),
      )
    : undefined;

  const allowedPayees: string[] | undefined = hasAllowedPayees
    ? PAYEES.filter(() => rand() < 0.6)
    : undefined;

  const allowedAssets: string[] | undefined = hasAllowedAssets
    ? ASSETS.filter(() => rand() < 0.6)
    : undefined;

  return { maxAmount, allowedPayees, allowedAssets };
}

// ---------------------------------------------------------------------------
// Reference predicate: should the offer pass?
// ---------------------------------------------------------------------------

function shouldPass(offer: PaymentOffer, checks: OfferChecks): boolean {
  // allowedAssets
  if (checks.allowedAssets && !checks.allowedAssets.includes(offer.asset)) return false;

  // maxAmount (fail-closed)
  if (checks.maxAmount) {
    const ceiling = checks.maxAmount[offer.asset];
    if (ceiling === undefined) return false;
    if (BigInt(offer.amount) > BigInt(ceiling)) return false;
  }

  // allowedPayees
  if (checks.allowedPayees && !checks.allowedPayees.includes(offer.payTo)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("property: runOfferChecks accepts exactly the offers within every bound", () => {
  it("holds for 500 random (offer, checks) pairs", () => {
    const rand = makePrng(0xdeadbeef);
    let counterexamples = 0;
    const failures: string[] = [];

    for (let i = 0; i < 500; i++) {
      const offer = randomOffer(rand);
      const checks = randomChecks(rand);
      const expected = shouldPass(offer, checks);

      let actual: boolean;
      try {
        runOfferChecks(offer, RESOURCE, "testnet", checks);
        actual = true;
      } catch (err) {
        if (err instanceof OfferRejectedError) {
          actual = false;
        } else {
          // Unexpected error (misconfigured ceiling, etc.) — rethrow.
          throw err;
        }
      }

      if (actual !== expected) {
        counterexamples++;
        if (failures.length < 5) {
          failures.push(
            `Trial ${i}: offer=${JSON.stringify(offer)} checks=${JSON.stringify(checks)} ` +
              `expected=${String(expected)} got=${String(actual)}`,
          );
        }
      }
    }

    if (counterexamples > 0) {
      throw new Error(
        `Property violated on ${counterexamples} trials. First examples:\n${failures.join("\n")}`,
      );
    }

    expect(counterexamples).toBe(0);
  });
});
