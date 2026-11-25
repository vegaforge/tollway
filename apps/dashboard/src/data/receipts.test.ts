/**
 * Tests for the receipts data seam: query semantics, cursor pagination, and
 * the trust model (key set returned separately from rows).
 */
import { describe, expect, it } from "vitest";

import { fetchReceipts } from "./receipts";

describe("fetchReceipts", () => {
  it("returns at least 60 rows in total (the full fixture)", async () => {
    // Fetch all by using a large limit.
    let total = 0;
    let cursor: string | null = null;
    do {
      const { page } = await fetchReceipts({ limit: 100, cursor: cursor ?? undefined });
      total += page.rows.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(total).toBeGreaterThanOrEqual(60);
  });

  it("covers all three models in the fixture", async () => {
    const { page } = await fetchReceipts({ limit: 100 });
    const models = new Set(page.rows.map((r) => r.receipt.model));
    expect(models).toContain("x402");
    expect(models).toContain("mpp-charge");
    expect(models).toContain("mpp-channel");
  });

  it("covers both assets in the fixture", async () => {
    const { page } = await fetchReceipts({ limit: 100 });
    const assets = new Set(page.rows.map((r) => r.receipt.asset.split(":")[0]));
    expect(assets).toContain("USDC");
    expect(assets).toContain("XLM");
  });

  it("filters by model", async () => {
    const { page } = await fetchReceipts({ model: "x402", limit: 100 });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.receipt.model).toBe("x402");
    }
  });

  it("filters by payer", async () => {
    const { page: all } = await fetchReceipts({ limit: 100 });
    const somePayer = all.rows[0]?.receipt.payer;
    expect(somePayer).toBeDefined();

    const { page } = await fetchReceipts({ payer: somePayer, limit: 100 });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.receipt.payer).toBe(somePayer);
    }
  });

  it("filters by payee", async () => {
    const { page: all } = await fetchReceipts({ limit: 100 });
    const somePayee = all.rows[0]?.receipt.payee;
    expect(somePayee).toBeDefined();

    const { page } = await fetchReceipts({ payee: somePayee, limit: 100 });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.receipt.payee).toBe(somePayee);
    }
  });

  it("filters by network", async () => {
    const { page } = await fetchReceipts({ network: "testnet", limit: 100 });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.receipt.network).toBe("testnet");
    }
  });

  it("filters by resourcePrefix", async () => {
    const { page } = await fetchReceipts({ resourcePrefix: "/v1/", limit: 100 });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.receipt.resource.startsWith("/v1/")).toBe(true);
    }
  });

  it("filters by from and to", async () => {
    const { page: all } = await fetchReceipts({ limit: 100 });
    const times = all.rows.map((r) => r.receipt.issuedAt).sort();
    // Pick a midpoint window.
    const from = times[Math.floor(times.length / 3)];
    const to = times[Math.floor((times.length * 2) / 3)];
    expect(from).toBeDefined();
    expect(to).toBeDefined();

    const { page } = await fetchReceipts({ from, to, limit: 100 });
    for (const row of page.rows) {
      expect(row.receipt.issuedAt >= (from as string)).toBe(true);
      expect(row.receipt.issuedAt < (to as string)).toBe(true);
    }
  });

  it("free-text search matches on receipt id", async () => {
    const { page: all } = await fetchReceipts({ limit: 100 });
    const id = all.rows[0]?.receipt.id;
    expect(id).toBeDefined();

    const { page } = await fetchReceipts({ search: id, limit: 10 });
    expect(page.rows.some((r) => r.receipt.id === id)).toBe(true);
  });

  it("cursor pagination returns non-overlapping pages that together cover all rows", async () => {
    const pageSize = 10;
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { page } = await fetchReceipts({ limit: pageSize, cursor: cursor ?? undefined });
      for (const row of page.rows) {
        expect(seen.has(row.receipt.id)).toBe(false);
        seen.add(row.receipt.id);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    // Pages should be more than one (fixture has ≥60 rows at pageSize=10).
    expect(pages).toBeGreaterThan(1);
  });

  it("throws RangeError for a stale cursor", async () => {
    await expect(fetchReceipts({ cursor: "rcpt-does-not-exist" })).rejects.toThrow(RangeError);
  });

  it("throws RangeError for an out-of-range limit", async () => {
    await expect(fetchReceipts({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(fetchReceipts({ limit: 101 })).rejects.toThrow(RangeError);
  });

  it("returns the key set separately from the rows", async () => {
    const { page, keySet } = await fetchReceipts({ limit: 1 });
    expect(page.rows.length).toBe(1);
    expect(keySet.source).toBeTruthy();
    expect(Object.keys(keySet.keys).length).toBeGreaterThan(0);
  });

  it("the key set source is not a data: URI or an inline key (independent path)", async () => {
    const { keySet } = await fetchReceipts({ limit: 1 });
    // The source must look like a path or URL, not a base64 blob.
    expect(keySet.source).not.toMatch(/^data:/i);
    expect(keySet.source.length).toBeLessThan(200);
  });

  it("all stub receipts have valid signatures against the returned key set", async () => {
    const { Ed25519Verifier, verifyReceipt } = await import("@vegaforge/tollway-core");
    let cursor: string | null = null;
    do {
      const { page, keySet } = await fetchReceipts({ limit: 100, cursor: cursor ?? undefined });
      const verifier = new Ed25519Verifier(keySet.keys);
      for (const row of page.rows) {
        const result = await verifyReceipt(row, verifier);
        expect(
          result.valid,
          `receipt ${row.receipt.id} failed: ${!result.valid ? result.reason : ""}`,
        ).toBe(true);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  });
});
