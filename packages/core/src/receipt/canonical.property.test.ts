import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TollwayError } from "../errors.js";
import { canonicalJson, type JsonValue } from "./canonical.js";

/**
 * Pinned seed so a CI failure replays exactly, matching
 * packages/reconcile/src/reconcile.property.test.ts.
 */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

/** JSON plus `undefined` object properties, which canonicalJson must drop. */
type NestedJson =
  | string
  | number
  | boolean
  | null
  | NestedJson[]
  | { [key: string]: NestedJson | undefined };

function shortTextArb(minLength: number, maxLength: number): fc.Arbitrary<string> {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789_-";
  return fc
    .array(fc.constantFrom(...chars.split("")), { minLength, maxLength })
    .map((letters) => letters.join(""));
}

function jsonArb(depth: number): fc.Arbitrary<NestedJson> {
  const leaves: Array<fc.Arbitrary<NestedJson>> = [
    fc.string({ maxLength: 12 }),
    fc.integer({ min: -100_000, max: 100_000 }),
    fc.boolean(),
    fc.constant(null),
  ];
  if (depth === 0) {
    return fc.oneof(...leaves);
  }
  const optionalValue = fc.oneof(jsonArb(depth - 1), fc.constant(undefined));
  return fc.oneof(
    ...leaves,
    fc.array(jsonArb(depth - 1), { maxLength: 3 }),
    fc
      .array(fc.tuple(shortTextArb(1, 8), optionalValue), { maxLength: 4 })
      .map((entries) => Object.fromEntries(entries)),
  );
}

/** The JSON value left after JSON.stringify's undefined-property dropping. */
function stripUndefined(value: NestedJson): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = stripUndefined(item);
    }
  }
  return result;
}

/** Rotates object keys at every depth; array order must not change. */
function permuteKeys(value: NestedJson | undefined, shift: number): NestedJson | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => permuteKeys(item, shift + 1)) as NestedJson[];
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return {};
  }
  const offset = ((shift % entries.length) + entries.length) % entries.length;
  const rotated = [...entries.slice(offset), ...entries.slice(0, offset)];
  return Object.fromEntries(
    rotated.map(([key, item], index) => [key, permuteKeys(item, shift + index + 1)]),
  );
}

function expectCanonicalizationFailure(value: NestedJson): void {
  try {
    canonicalJson(value as JsonValue);
    expect.fail("canonicalJson should have rejected a non-finite number");
  } catch (error) {
    expect(error).toBeInstanceOf(TollwayError);
    expect((error as TollwayError).code).toBe("canonicalization-failed");
  }
}

const nonFiniteArb = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
);
const nonFiniteContainerArb: fc.Arbitrary<NestedJson> = fc.oneof(
  nonFiniteArb,
  nonFiniteArb.map((value) => [value]),
  nonFiniteArb.map((value) => ({ nested: { value } })),
  nonFiniteArb.map((value) => ({ a: 1, b: [value] })),
);

describe("canonicalJson properties", () => {
  it("is identical for any key permutation at every depth", () => {
    fc.assert(
      fc.property(jsonArb(3), fc.nat(10_000), (value, shift) => {
        const original = canonicalJson(value as JsonValue);
        expect(canonicalJson(permuteKeys(value, shift) as unknown as JsonValue)).toBe(original);
      }),
      ASSERT_OPTS,
    );
  });

  it("round-trips through JSON.parse with undefined properties removed", () => {
    fc.assert(
      fc.property(jsonArb(3), (value) => {
        const parsed: unknown = JSON.parse(canonicalJson(value as JsonValue));
        expect(parsed).toEqual(stripUndefined(value));
      }),
      ASSERT_OPTS,
    );
  });

  it("is idempotent through a parse", () => {
    fc.assert(
      fc.property(jsonArb(3), (value) => {
        const once = canonicalJson(value as JsonValue);
        const parsed: unknown = JSON.parse(once);
        expect(canonicalJson(parsed as JsonValue)).toBe(once);
      }),
      ASSERT_OPTS,
    );
  });

  it("emits no insignificant whitespace outside JSON strings", () => {
    fc.assert(
      fc.property(jsonArb(3), (value) => {
        const withoutStrings = canonicalJson(value as JsonValue).replace(
          /"(?:[^"\\]|\\.)*"/g,
          '""',
        );
        expect(withoutStrings).not.toMatch(/\s/);
      }),
      ASSERT_OPTS,
    );
  });

  it("rejects non-finite numbers with TollwayError canonicalization-failed", () => {
    fc.assert(
      fc.property(nonFiniteContainerArb, (value) => {
        expectCanonicalizationFailure(value);
      }),
      ASSERT_OPTS,
    );
  });
});
