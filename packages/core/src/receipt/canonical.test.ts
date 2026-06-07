import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";

describe("canonicalJson", () => {
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
    expect(canonicalJson(null)).toBe("null");
  });

  it("rejects numbers JSON cannot represent", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow("canonicalize");
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow("canonicalize");
  });
});
