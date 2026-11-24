import { describe, expect, it } from "vitest";

import { assetCode, formatAmount, shareBasisPoints, sumByAsset } from "./amount";

describe("formatAmount", () => {
  it("shows zero with two places", () => {
    expect(formatAmount("0", "USDC")).toBe("0.00 USDC");
  });

  it("keeps every digit of a sub-unit amount", () => {
    // 120000 base units is 0.012 USDC at 7 decimals. Truncating to two places
    // would show 0.01 and hide three tenths of a cent.
    expect(formatAmount("120000", "USDC")).toBe("0.012 USDC");
    expect(formatAmount("1", "USDC")).toBe("0.0000001 USDC");
  });

  it("groups a large whole amount and pads a whole amount to two places", () => {
    expect(formatAmount("12345600000", "USDC")).toBe("1,234.56 USDC");
    expect(formatAmount("5000000000", "USDC")).toBe("500.00 USDC");
  });

  it("formats a very large amount beyond Number.MAX_SAFE_INTEGER exactly", () => {
    // 9_007_199_254_740_993 base units is 900,719,925.4740993 USDC.
    expect(formatAmount("9007199254740993", "USDC")).toBe("900,719,925.4740993 USDC");
  });

  it("uses the decimals it is given", () => {
    expect(formatAmount("1500", "XYZ", 3)).toBe("1.50 XYZ");
    expect(formatAmount("42", "XYZ", 0)).toBe("42 XYZ");
  });

  it("drops the issuer from an asset id", () => {
    expect(formatAmount("50000000", "USDC:GA5Z")).toBe("5.00 USDC");
  });

  it("shows a malformed amount as received instead of as a number", () => {
    expect(formatAmount("12.5", "USDC")).toBe("12.5 USDC");
    expect(formatAmount("-3", "USDC")).toBe("-3 USDC");
    expect(formatAmount("abc", "USDC")).toBe("abc USDC");
  });
});

describe("assetCode", () => {
  it("returns the code before the issuer", () => {
    expect(assetCode("USDC:GA5Z")).toBe("USDC");
    expect(assetCode("XLM")).toBe("XLM");
  });
});

describe("sumByAsset", () => {
  it("adds amounts within one asset and keeps assets apart", () => {
    const rows = [
      { asset: "USDC", amount: "1000" },
      { asset: "XLM", amount: "3000" },
      { asset: "USDC", amount: "2500" },
    ];

    expect(sumByAsset(rows, (row) => row.amount)).toEqual([
      { asset: "USDC", amount: "3500" },
      { asset: "XLM", amount: "3000" },
    ]);
  });

  it("returns no entries for no rows, so no asset is invented", () => {
    expect(sumByAsset([], (row: { asset: string }) => row.asset)).toEqual([]);
  });
});

describe("shareBasisPoints", () => {
  it("rounds to the nearest basis point instead of truncating", () => {
    // 126000000 of 134823000 is 93.4558...%, which reads 93.46%.
    expect(shareBasisPoints(126_000_000n, 134_823_000n)).toBe(9346n);
  });

  it("rounds an exact half up", () => {
    // 1 of 20000 is half a basis point.
    expect(shareBasisPoints(1n, 20_000n)).toBe(1n);
  });

  it("keeps whole shares exact", () => {
    expect(shareBasisPoints(1n, 4n)).toBe(2500n);
    expect(shareBasisPoints(5n, 5n)).toBe(10_000n);
  });

  it("is zero for a zero total", () => {
    expect(shareBasisPoints(0n, 0n)).toBe(0n);
  });
});
