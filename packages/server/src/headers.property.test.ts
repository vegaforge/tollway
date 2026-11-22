import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeHeader, encodeHeader, readHeader } from "./headers.js";

/** Pinned seed so a CI failure replays exactly, as in reconcile.property.test.ts. */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

const NAME_CHARS = "abcdefghijklmnopqrstuvwxyz";

function nameArb(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...NAME_CHARS.split("")), { minLength, maxLength })
    .map((letters) => letters.join(""));
}

function applyCasing(name: string, mask: number): string {
  return name
    .split("")
    .map((letter, index) => (((mask >> index) & 1) === 1 ? letter.toUpperCase() : letter))
    .join("");
}

/**
 * decodeHeader throws SyntaxError when base64url decodes to text that is not
 * JSON, and DOMException (InvalidCharacterError) from atob for invalid
 * base64url input. Both are Error instances; the fuzz properties enforce that
 * contract instead of assuming a single message.
 */
function expectDecodeToReturnValueOrThrow(value: string): void {
  try {
    const decoded: unknown = decodeHeader<unknown>(value);
    expect(decoded).not.toBeUndefined();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
}

/**
 * JSON has no negative zero: `JSON.stringify(-0)` is `"0"`. That is a limit
 * of the format, not of the header codec, so the round trip expects `0`
 * wherever the input held `-0` and is exact everywhere else.
 */
function withoutNegativeZero(value: unknown): unknown {
  if (Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(withoutNegativeZero);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withoutNegativeZero(entry)]),
    );
  }
  return value;
}

// `binary` strings cover every UTF-16 code unit, so they include non-ASCII
// text, astral characters and lone surrogates. fast-check's default unit is
// ASCII only.
const ANY_TEXT = { unit: "binary" } as const;

describe("header properties", () => {
  it("round-trips arbitrary JSON values through the encode/decode pair", () => {
    fc.assert(
      fc.property(fc.jsonValue({ stringUnit: "binary" }), (value) => {
        expect(decodeHeader<unknown>(encodeHeader(value))).toEqual(withoutNegativeZero(value));
      }),
      ASSERT_OPTS,
    );
  });

  it("turns negative zero into zero, as JSON does", () => {
    expect(Object.is(decodeHeader<{ n: number }>(encodeHeader({ n: -0 })).n, 0)).toBe(true);
  });

  it("round-trips non-ASCII text, including lone surrogates", () => {
    fc.assert(
      fc.property(fc.string({ ...ANY_TEXT, maxLength: 40 }), (text) => {
        const value = { note: text, sample: "🚀-ñ-漢字", lone: "\ud800x\udc00" };
        expect(decodeHeader<typeof value>(encodeHeader(value))).toEqual(value);
      }),
      ASSERT_OPTS,
    );
  });

  it("reads a header case-insensitively for arbitrary casing", () => {
    fc.assert(
      fc.property(
        nameArb(1, 10),
        fc.string({ maxLength: 20 }),
        fc.nat({ max: 1023 }),
        (name, value, mask) => {
          const cased = applyCasing(name, mask);
          const headers: Record<string, string | string[] | undefined> = {
            "x-noise": "other",
            [cased]: value,
          };
          expect(readHeader(headers, name)).toBe(value);
          expect(readHeader(headers, cased.toUpperCase())).toBe(value);
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("returns the first of repeated values", () => {
    fc.assert(
      fc.property(
        nameArb(1, 10),
        fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
        (name, values) => {
          const headers: Record<string, string | string[] | undefined> = {
            [name.toUpperCase()]: values,
          };
          expect(readHeader(headers, name.toLowerCase())).toBe(values.at(0));
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("never returns undefined or a non-Error throw for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ ...ANY_TEXT, maxLength: 200 }), (raw) => {
        expectDecodeToReturnValueOrThrow(raw);
      }),
      ASSERT_OPTS,
    );
  });

  it("never returns undefined or a non-Error throw for arbitrary byte strings", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expectDecodeToReturnValueOrThrow(Buffer.from(bytes).toString("base64url"));
      }),
      ASSERT_OPTS,
    );
  });
});
