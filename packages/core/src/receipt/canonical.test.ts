import { describe, expect, it } from "vitest";
import { TollwayError } from "../errors.js";
import { canonicalBytes, canonicalJson } from "./canonical.js";

/**
 * Issue #165 coverage. The three defects the issue lists are pinned down
 * first (red before green per AGENTS.md Directive 3), then the RFC 8785
 * examples and Appendix B number samples, then the invariants the new
 * code relies on.
 */

describe("canonicalJson", () => {
  describe("basics kept from the pre-#165 serialiser", () => {
    it("sorts object keys at every level", () => {
      const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
      const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
      expect(a).toBe(b);
      expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
    });

    it("keeps array order, which is meaningful", () => {
      expect(canonicalJson([2, 1])).toBe("[2,1]");
    });

    it("handles primitives and null", () => {
      expect(canonicalJson("x")).toBe('"x"');
      expect(canonicalJson(true)).toBe("true");
      expect(canonicalJson(false)).toBe("false");
      expect(canonicalJson(null)).toBe("null");
    });

    it("drops `undefined` properties on objects the way JSON.stringify does", () => {
      // This is the single spelling for "not present" callers may rely on;
      // undefined in an *array* still throws (RFC 8785 I-JSON).
      const result = canonicalJson({
        a: 1,
        b: undefined as unknown as never,
        c: 2,
      } as unknown as { a: number; c: number });
      expect(result).toBe('{"a":1,"c":2}');
    });
  });

  describe("defects the issue lists (red then green)", () => {
    it("rejects a lone high surrogate in a string value", () => {
      expect(() => canonicalJson("\ud800")).toThrow(TollwayError);
      expect(() => canonicalJson("\ud800")).toThrow(/lone high surrogate/);
    });

    it("rejects a lone low surrogate in a string value", () => {
      expect(() => canonicalJson("\udc00")).toThrow(/lone low surrogate/);
    });

    it("rejects a lone surrogate in an object key", () => {
      expect(() => canonicalJson({ "\ud800key": 1 })).toThrow(/lone high surrogate/);
    });

    it("accepts a well-formed surrogate pair (U+1F600 GRINNING FACE)", () => {
      // The codepoint U+1F600 encodes as the UTF-16 pair D83D DE00; RFC 8785
      // section 3.2.2.2 only requires escaping of U+0000-U+001F, U+0022 and
      // U+005C, so a printable supplementary-plane character is emitted
      // verbatim as its UTF-8 bytes rather than as a \uXXXX escape.
      expect(canonicalJson("😀")).toBe('"😀"');
    });

    it("rejects `undefined` inside an array with a canonicalization-failed error, not a raw TypeError", () => {
      const input = [1, undefined as unknown as never, 3] as unknown as [number, number, number];
      let err: unknown;
      try {
        canonicalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TollwayError);
      expect((err as TollwayError).code).toBe("canonicalization-failed");
      expect((err as TollwayError).message).toMatch(/undefined at/);
      expect(err).not.toBeInstanceOf(TypeError);
    });

    it("rejects a Date (a non-plain object) rather than silently rendering {}", () => {
      const input = { d: new Date(0) } as unknown as { d: never };
      expect(() => canonicalJson(input)).toThrow(/non-plain object/);
    });

    it("rejects a class instance (non-plain object)", () => {
      class Thing {
        value = 1;
      }
      const input = { t: new Thing() } as unknown as { t: never };
      expect(() => canonicalJson(input)).toThrow(/non-plain object/);
    });

    it("rejects a Map (non-plain object)", () => {
      const input = { m: new Map() } as unknown as { m: never };
      expect(() => canonicalJson(input)).toThrow(/non-plain object/);
    });

    it("accepts a null-prototype object", () => {
      const obj = Object.create(null) as Record<string, number>;
      obj.a = 1;
      expect(canonicalJson(obj)).toBe('{"a":1}');
    });
  });

  describe("other no-representation inputs", () => {
    it("rejects bigint", () => {
      expect(() => canonicalJson(1n as unknown as never)).toThrow(/bigint/);
    });

    it("rejects a symbol value", () => {
      expect(() => canonicalJson({ s: Symbol("x") } as unknown as { s: never })).toThrow(/symbol/);
    });

    it("rejects a function value", () => {
      expect(() => canonicalJson({ f: () => 1 } as unknown as { f: never })).toThrow(/function/);
    });

    it("rejects NaN and infinities", () => {
      expect(() => canonicalJson(Number.NaN)).toThrow(TollwayError);
      expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TollwayError);
      expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(TollwayError);
    });
  });

  describe("RFC 8785 examples", () => {
    it("sorts keys by UTF-16 code units, matching the RFC 3.2.3 example", () => {
      // The same input as the RFC, in a shuffled order. The RFC's expected
      // order is: \r (U+000D), € (EURO SIGN), \u{1f602} (FACE WITH
      // TEARS OF JOY, pair D83D DE02), דּ (HEBREW LETTER DALET WITH
      // DAGESH). Node's Object.keys preserves insertion order, then
      // Array.prototype.sort picks the UTF-16 code-unit ordering, so the
      // high surrogate 0xD83D precedes the BMP letter 0xFB33.
      const input: Record<string, number> = {
        "€": 1,
        "\r": 2,
        "😂": 3,
        דּ: 4,
      };
      const out = canonicalJson(input);
      expect(out).toBe('{"\\r":2,"€":1,"😂":3,"דּ":4}');
    });

    it("formats numbers per ECMA-262 ToString(Number), the JCS 3.2.2.3 rule", () => {
      // A representative subset of the RFC 8785 Appendix B number cases.
      // Values that cannot round-trip or that JS rejects (-0 round-tripping,
      // signalling NaN, etc.) are excluded; a widely used subset is enough
      // to pin down the ECMA-262 Number-to-String behaviour JCS requires.
      expect(canonicalJson(0)).toBe("0");
      expect(canonicalJson(-0)).toBe("0"); // -0 renders as 0 per ECMA-262.
      expect(canonicalJson(1)).toBe("1");
      expect(canonicalJson(-1)).toBe("-1");
      expect(canonicalJson(1.5)).toBe("1.5");
      expect(canonicalJson(1e21)).toBe("1e+21");
      expect(canonicalJson(1e-7)).toBe("1e-7");
      expect(canonicalJson(1e-6)).toBe("0.000001");
      // Max safe integer and the next step beyond.
      expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    });
  });

  describe("canonicalBytes", () => {
    it("is the UTF-8 encoding of canonicalJson for an ASCII input", () => {
      const bytes = canonicalBytes({ a: 1 });
      // `{"a":1}`
      expect(Array.from(bytes)).toEqual([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d]);
    });

    it("emits a Supplementary Multilingual Plane character as its UTF-8 bytes", () => {
      const bytes = canonicalBytes("😀");
      // `"😀"` renders as two ASCII quotes + four UTF-8 bytes for U+1F600.
      expect(bytes.length).toBe(6);
    });
  });
});
