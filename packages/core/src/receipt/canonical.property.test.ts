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

// `binary` strings cover every UTF-16 code unit: non-ASCII text, astral
// characters and lone surrogates. fast-check's default unit is ASCII only.
const textArb = fc.string({ unit: "binary", maxLength: 12 });

// Keys where ordering and object semantics are easiest to get wrong: integer
// keys (which JavaScript objects enumerate first), `__proto__`, non-ASCII, and
// pairs whose UTF-16 order differs from code point order.
const keyArb = fc.oneof(
  fc.string({ unit: "binary", minLength: 1, maxLength: 8 }),
  fc.constantFrom("__proto__", "0", "2", "10", "a", "B", "é", "\uffff", "😀", "\ud800"),
);

// Finite doubles, including -0, fractions and both ends of the exponent
// range, where number formatting differs between serializers.
const numberArb = fc.oneof(
  fc.integer({ min: -100_000, max: 100_000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(-0, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 2),
);

function jsonArb(depth: number): fc.Arbitrary<NestedJson> {
  const leaves: Array<fc.Arbitrary<NestedJson>> = [
    textArb,
    numberArb,
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
    fc.array(fc.tuple(keyArb, optionalValue), { maxLength: 4 }).map(objectFromEntries),
  );
}

/**
 * Builds an object with own properties only, so a `__proto__` key is data
 * rather than a prototype change.
 */
function objectFromEntries(
  entries: ReadonlyArray<readonly [string, NestedJson | undefined]>,
): NestedJson {
  const result: { [key: string]: NestedJson | undefined } = {};
  for (const [key, item] of entries) {
    Object.defineProperty(result, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** The JSON value left after JSON.stringify's undefined-property dropping. */
function stripUndefined(value: NestedJson): JsonValue {
  // JSON has no negative zero; `-0` serializes as `0`.
  if (Object.is(value, -0)) {
    return 0;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  const entries: Array<[string, NestedJson]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      entries.push([key, stripUndefined(item) as NestedJson]);
    }
  }
  return objectFromEntries(entries) as JsonValue;
}

/**
 * Rebuilds the value with object keys inserted in a shuffled order at every
 * depth; array order must not change. The order comes from a seeded
 * generator, so any permutation can occur, not just a rotation. JavaScript
 * still enumerates integer-like keys first, whatever the insertion order.
 */
function permuteKeys(value: NestedJson | undefined, random: () => number): NestedJson | undefined {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => permuteKeys(item, random)) as NestedJson[];
  }
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const swap = entries[index];
    const pick = entries[other];
    if (swap === undefined || pick === undefined) continue;
    entries[index] = pick;
    entries[other] = swap;
  }
  return objectFromEntries(entries.map(([key, item]) => [key, permuteKeys(item, random)]));
}

/** A small deterministic generator (mulberry32) for the key shuffle. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
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
/** A JSON value with one non-finite number placed anywhere inside it. */
function withNonFiniteArb(depth: number): fc.Arbitrary<NestedJson> {
  if (depth === 0) {
    return nonFiniteArb;
  }
  const inner = withNonFiniteArb(depth - 1);
  return fc.oneof(
    nonFiniteArb,
    fc.tuple(fc.array(jsonArb(1), { maxLength: 3 }), inner, fc.nat()).map(([items, bad, at]) => {
      const copy = [...items];
      copy.splice(at % (copy.length + 1), 0, bad);
      return copy;
    }),
    fc
      .tuple(fc.array(fc.tuple(keyArb, jsonArb(1)), { maxLength: 3 }), keyArb, inner)
      .map(([entries, key, bad]) =>
        objectFromEntries([...entries.filter(([other]) => other !== key), [key, bad]]),
      ),
  );
}

describe("canonicalJson properties", () => {
  it("is identical for any key permutation at every depth", () => {
    fc.assert(
      fc.property(jsonArb(3), fc.integer(), (value, seed) => {
        const original = canonicalJson(value as JsonValue);
        const permuted = permuteKeys(value, seededRandom(seed));
        expect(canonicalJson(permuted as unknown as JsonValue)).toBe(original);
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
      fc.property(withNonFiniteArb(3), (value) => {
        expectCanonicalizationFailure(value);
      }),
      ASSERT_OPTS,
    );
  });
});
