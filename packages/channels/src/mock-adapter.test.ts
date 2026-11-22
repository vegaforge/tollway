/**
 * Tests for the offline mock MPP channel adapter.
 * See packages/channels/src/mock-adapter.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { createMockMppChannelAdapter } from "./mock-adapter.js";

// ── deterministic output ──────────────────────────────────────────────────────

describe("createMockMppChannelAdapter", () => {
  it("produces a deterministic channel id for the same inputs", async () => {
    const { adapter } = createMockMppChannelAdapter();
    const input = {
      counterparty: "GRECIPIENT",
      asset: "USDC",
      deposit: "10000000",
      network: "testnet" as const,
    };

    const first = await adapter.openChannel(input);
    // A second adapter instance with the same first call gets the same id.
    const { adapter: adapter2 } = createMockMppChannelAdapter();
    const second = await adapter2.openChannel(input);

    expect(first.channelId).toBe(second.channelId);
    expect(first.openTxHash).toBe(second.openTxHash);
  });

  it("produces different channel ids for different open calls on the same adapter", async () => {
    const { adapter } = createMockMppChannelAdapter();
    const base = { asset: "USDC", deposit: "10000000", network: "testnet" as const };

    const r1 = await adapter.openChannel({ ...base, counterparty: "GRECIPIENT_A" });
    const r2 = await adapter.openChannel({ ...base, counterparty: "GRECIPIENT_B" });

    expect(r1.channelId).not.toBe(r2.channelId);
  });

  it("produces a deterministic commitment blob for signCommitment", async () => {
    const { adapter } = createMockMppChannelAdapter();
    const input = {
      channelId: "CTEST001",
      cumulativeAmount: "5000",
      network: "testnet" as const,
    };

    const r1 = await adapter.signCommitment(input);
    const r2 = await adapter.signCommitment(input);

    expect(r1.commitment).toBe(r2.commitment);
    // The blob encodes the channel id and amount so assertions stay transparent.
    expect(r1.commitment).toContain("CTEST001");
    expect(r1.commitment).toContain("5000");
  });

  it("settles exactly the cumulative amount and returns the correct remainder", async () => {
    const { adapter } = createMockMppChannelAdapter();
    const result = await adapter.closeChannel({
      channelId: "CTEST001",
      network: "testnet" as const,
      cumulativeAmount: "3000",
      commitment: "mock:CTEST001:3000",
      deposit: "10000",
    });

    expect(result.settledAmount).toBe("3000");
    expect(result.returnedRemainder).toBe("7000");
    expect(result.settlementTxHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a zero remainder when the full deposit is committed", async () => {
    const { adapter } = createMockMppChannelAdapter();
    const result = await adapter.closeChannel({
      channelId: "CTEST001",
      network: "testnet" as const,
      cumulativeAmount: "10000",
      commitment: "mock:CTEST001:10000",
      deposit: "10000",
    });

    expect(result.settledAmount).toBe("10000");
    expect(result.returnedRemainder).toBe("0");
  });

  it("logs calls so tests can assert call counts", async () => {
    const { adapter, calls } = createMockMppChannelAdapter();
    const openInput = {
      counterparty: "GRECIPIENT",
      asset: "USDC",
      deposit: "1000",
      network: "testnet" as const,
    };

    await adapter.openChannel(openInput);
    await adapter.signCommitment({
      channelId: "C001",
      cumulativeAmount: "100",
      network: "testnet",
    });
    await adapter.signCommitment({
      channelId: "C001",
      cumulativeAmount: "200",
      network: "testnet",
    });
    await adapter.closeChannel({
      channelId: "C001",
      network: "testnet" as const,
      cumulativeAmount: "200",
      commitment: "mock:C001:200",
      deposit: "1000",
    });

    expect(calls.openChannel).toHaveLength(1);
    expect(calls.signCommitment).toHaveLength(2);
    expect(calls.closeChannel).toHaveLength(1);
  });

  it("never calls globalThis.fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in mock"));
    const { adapter } = createMockMppChannelAdapter();

    await adapter.openChannel({
      counterparty: "G",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await adapter.signCommitment({ channelId: "C1", cumulativeAmount: "500", network: "testnet" });
    await adapter.closeChannel({
      channelId: "C1",
      network: "testnet",
      cumulativeAmount: "500",
      commitment: "x",
      deposit: "1000",
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("produces a deterministic close tx hash for the same channel and cumulative amount", async () => {
    const { adapter: a1 } = createMockMppChannelAdapter();
    const { adapter: a2 } = createMockMppChannelAdapter();
    const input = {
      channelId: "CTEST001",
      network: "testnet" as const,
      cumulativeAmount: "9999",
      commitment: "mock:CTEST001:9999",
      deposit: "10000",
    };

    const r1 = await a1.closeChannel(input);
    const r2 = await a2.closeChannel(input);

    expect(r1.settlementTxHash).toBe(r2.settlementTxHash);
  });
});
