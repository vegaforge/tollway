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
    // Non-ASCII text is written as \u escapes throughout, so no editor or
    // formatter can normalise it. U+FB33 normalises to U+05D3 U+05BC under
    // NFC, which would sort differently and hide the case the RFC is about.

    it("sorts keys by UTF-16 code units: the RFC section 3.2.3 example", () => {
      // RFC 8785 section 3.2.3, input in the RFC's order.
      const input: Record<string, string> = {
        "\u20ac": "Euro Sign",
        "\r": "Carriage Return",
        "\ufb33": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "\ud83d\ude00": "Emoji: Grinning Face",
        "\u0080": "Control",
        "\u00f6": "Latin Small Letter O With Diaeresis",
      };
      // The RFC's expected order: \r, 1, U+0080, U+00F6, U+20AC, then the
      // emoji (high surrogate 0xD83D) before U+FB33, which a code point sort
      // would reverse.
      expect(canonicalJson(input)).toBe(
        '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
      );
    });

    it("escapes strings as the RFC section 3.2.2.2 example shows", () => {
      // RFC 8785 section 3.2.2.2: only U+0000-U+001F, the quote and the
      // backslash are escaped; the slash and everything else are literal.
      const input = { string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/" };
      expect(canonicalJson(input)).toBe('{"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
    });

    // RFC 8785 Appendix B: IEEE 754 bit patterns and the text JCS requires
    // for each, copied from the RFC. The two non-finite rows are refused.
    const APPENDIX_B: readonly [hex: string, expected: string][] = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ];

    function fromBits(hex: string): number {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, BigInt(`0x${hex}`));
      return view.getFloat64(0);
    }

    it.each(APPENDIX_B)("formats the Appendix B number %s as %s", (hex, expected) => {
      expect(canonicalJson(fromBits(hex))).toBe(expected);
    });

    it.each([
      "7fffffffffffffff",
      "7ff0000000000000",
    ])("refuses the Appendix B non-finite number %s", (hex) => {
      expect(() => canonicalJson(fromBits(hex))).toThrow(
        expect.objectContaining({ code: "canonicalization-failed" }),
      );
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
