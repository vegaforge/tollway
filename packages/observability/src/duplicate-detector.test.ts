import { describe, it, expect } from "vitest";
import { createDuplicateDetector } from "./duplicate-detector.js";

describe("Duplicate settlement detector", () => {
  it("detects duplicates", () => {
    const detector = createDuplicateDetector();
    expect(detector.record("nonce-123", "x402")).toBe(true);
    expect(detector.isDuplicate("nonce-123", "x402")).toBe(true);
    expect(detector.record("nonce-123", "x402")).toBe(false);
  });

  it("distinguishes by model", () => {
    const detector = createDuplicateDetector();
    detector.record("key-1", "x402");
    expect(detector.record("key-1", "mpp-channel")).toBe(true);
  });

  it("tracks all records", () => {
    const detector = createDuplicateDetector();
    detector.record("key-1", "x402");
    detector.record("key-2", "mpp-charge");
    const records = detector.getRecords();
    expect(records).toHaveLength(2);
  });

  it("clears records", () => {
    const detector = createDuplicateDetector();
    detector.record("key-1", "x402");
    detector.clear();
    expect(detector.getRecords()).toHaveLength(0);
  });

  it("respects TTL", async () => {
    const detector = createDuplicateDetector({ ttlMs: 10 });
    detector.record("key-1", "x402");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(detector.isDuplicate("key-1", "x402")).toBe(false);
  });

  it("enforces max capacity", () => {
    const detector = createDuplicateDetector({ maxRecords: 10 });
    for (let i = 0; i < 15; i++) {
      detector.record(`key-${i}`, "x402");
    }
    const records = detector.getRecords();
    expect(records.length).toBeLessThanOrEqual(10);
  });
});
