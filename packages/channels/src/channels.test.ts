import { NotImplementedError } from "@tollway/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloseAdapterInput,
  CloseAdapterResult,
  MppChannelAdapter,
  OpenAdapterInput,
  OpenAdapterResult,
  SignCommitmentInput,
  SignedCommitment,
} from "./adapter.js";
import {
  ChannelAlreadyClosedError,
  ChannelNotFoundError,
  ChannelNotOpenError,
  CommitmentExceedsDepositError,
  InvalidAmountError,
  SettlementMismatchError,
} from "./errors.js";
import { createChannelManager } from "./manager.js";
import { createMemoryCommitmentStore } from "./store.js";

// ── test double ───────────────────────────────────────────────────────────────

type FakeAdapterCalls = {
  openChannel: OpenAdapterInput[];
  signCommitment: SignCommitmentInput[];
  closeChannel: CloseAdapterInput[];
};

function createFakeAdapter(overrides?: {
  open?: (input: OpenAdapterInput) => OpenAdapterResult | Promise<OpenAdapterResult>;
  sign?: (input: SignCommitmentInput) => SignedCommitment | Promise<SignedCommitment>;
  close?: (input: CloseAdapterInput) => CloseAdapterResult | Promise<CloseAdapterResult>;
}): { adapter: MppChannelAdapter; calls: FakeAdapterCalls } {
  const calls: FakeAdapterCalls = { openChannel: [], signCommitment: [], closeChannel: [] };
  let openCount = 0;
  let closeCount = 0;

  const adapter: MppChannelAdapter = {
    async openChannel(input) {
      calls.openChannel.push(input);
      if (overrides?.open) return overrides.open(input);
      openCount += 1;
      return {
        channelId: `CTEST${openCount.toString().padStart(3, "0")}`,
        openTxHash: `tx-open-${openCount}`,
      };
    },
    async signCommitment(input) {
      calls.signCommitment.push(input);
      if (overrides?.sign) return overrides.sign(input);
      return {
        commitment: `sig:${input.channelId}:${input.cumulativeAmount}`,
      };
    },
    async closeChannel(input) {
      calls.closeChannel.push(input);
      if (overrides?.close) return overrides.close(input);
      closeCount += 1;
      // Default behaviour: settle the whole cumulative, return deposit - cumulative.
      const remainder = BigInt(input.deposit) - BigInt(input.cumulativeAmount);
      return {
        settlementTxHash: `tx-close-${closeCount}`,
        settledAmount: input.cumulativeAmount,
        returnedRemainder: remainder.toString(),
      };
    },
  };

  return { adapter, calls };
}

// ── open ──────────────────────────────────────────────────────────────────────

describe("ChannelManager.open", () => {
  it("opens a channel and returns a tracked record with zero committed", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });

    const channel = await manager.open({
      counterparty: "GRECIPIENT",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      deposit: "10000000",
      network: "testnet",
    });

    expect(channel.id).toBe("CTEST001");
    expect(channel.counterparty).toBe("GRECIPIENT");
    expect(channel.asset).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    expect(channel.deposit).toBe("10000000");
    expect(channel.committed).toBe("0");
    expect(channel.sequence).toBe(-1);
    expect(channel.status).toBe("open");
    expect(channel.network).toBe("testnet");
    expect(channel.openTxHash).toBe("tx-open-1");

    expect(calls.openChannel).toHaveLength(1);
    expect(calls.openChannel[0]).toMatchObject({
      counterparty: "GRECIPIENT",
      deposit: "10000000",
      network: "testnet",
    });
  });

  it("persists the channel record so it can be read back via get", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter });

    const opened = await manager.open({
      counterparty: "GRECIPIENT",
      asset: "USDC",
      deposit: "500",
      network: "testnet",
    });

    const fetched = await manager.get(opened.id);
    expect(fetched).toEqual(opened);
  });

  it("rejects a zero or empty deposit before talking to the adapter", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });

    await expect(
      manager.open({ counterparty: "GR", asset: "USDC", deposit: "0", network: "testnet" }),
    ).rejects.toBeInstanceOf(InvalidAmountError);

    await expect(
      manager.open({ counterparty: "GR", asset: "USDC", deposit: "", network: "testnet" }),
    ).rejects.toBeInstanceOf(InvalidAmountError);

    await expect(
      manager.open({ counterparty: "GR", asset: "USDC", deposit: "-5", network: "testnet" }),
    ).rejects.toBeInstanceOf(InvalidAmountError);

    expect(calls.openChannel).toHaveLength(0);
  });

  it("surfaces adapter errors directly without wrapping them", async () => {
    const sentinel = new Error("contract call reverted");
    const { adapter } = createFakeAdapter({
      open: () => {
        throw sentinel;
      },
    });
    const manager = createChannelManager({ adapter });

    await expect(
      manager.open({
        counterparty: "GR",
        asset: "USDC",
        deposit: "100",
        network: "testnet",
      }),
    ).rejects.toBe(sentinel);
  });
});

// ── commit ────────────────────────────────────────────────────────────────────

describe("ChannelManager.commit", () => {
  it("advances cumulative commitment by amount and increments sequence", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    const first = await manager.commit(channel.id, "10");
    expect(first.sequence).toBe(0);
    expect(first.cumulativeAmount).toBe("10");
    expect(first.commitment).toBe(`sig:${channel.id}:10`);

    const second = await manager.commit(channel.id, "25");
    expect(second.sequence).toBe(1);
    expect(second.cumulativeAmount).toBe("35");

    const third = await manager.commit(channel.id, "65");
    expect(third.sequence).toBe(2);
    expect(third.cumulativeAmount).toBe("100");

    const refreshed = await manager.get(channel.id);
    expect(refreshed?.committed).toBe("100");
    expect(refreshed?.sequence).toBe(2);

    // The adapter saw each cumulative amount in monotonic order.
    expect(calls.signCommitment.map((c) => c.cumulativeAmount)).toEqual(["10", "35", "100"]);
  });

  it("returns the full ordered commitment stream via list", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await manager.commit(channel.id, "1");
    await manager.commit(channel.id, "2");
    await manager.commit(channel.id, "3");

    const stream = await manager.list(channel.id);
    expect(stream.map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(stream.map((c) => c.cumulativeAmount)).toEqual(["1", "3", "6"]);
  });

  it("throws when committing on an unknown channel", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter });

    await expect(manager.commit("CNOPE", "10")).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it("rejects a zero or non-integer amount before talking to the adapter", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await expect(manager.commit(channel.id, "0")).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(manager.commit(channel.id, "1.5")).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(manager.commit(channel.id, "-1")).rejects.toBeInstanceOf(InvalidAmountError);

    expect(calls.signCommitment).toHaveLength(0);
  });

  it("rejects a commit that would push cumulative beyond the deposit", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "100",
      network: "testnet",
    });

    await manager.commit(channel.id, "60");
    await expect(manager.commit(channel.id, "50")).rejects.toBeInstanceOf(
      CommitmentExceedsDepositError,
    );

    // The first commit ran; the second was rejected before reaching the adapter.
    expect(calls.signCommitment).toHaveLength(1);

    const stream = await manager.list(channel.id);
    expect(stream).toHaveLength(1);
  });

  it("allows a commit that exactly equals the deposit", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "100",
      network: "testnet",
    });

    const result = await manager.commit(channel.id, "100");
    expect(result.cumulativeAmount).toBe("100");

    await expect(manager.commit(channel.id, "1")).rejects.toBeInstanceOf(
      CommitmentExceedsDepositError,
    );
  });

  it("refuses to commit on a channel that is not in status open", async () => {
    const { adapter } = createFakeAdapter();
    const store = createMemoryCommitmentStore();
    const manager = createChannelManager({ adapter, store });

    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await store.updateChannel(channel.id, { status: "closed" });

    await expect(manager.commit(channel.id, "10")).rejects.toBeInstanceOf(ChannelNotOpenError);
  });
});

// ── off-chain invariant ───────────────────────────────────────────────────────

describe("ChannelManager off-chain invariant", () => {
  it("runs many commitments without invoking openChannel a second time", async () => {
    // The adapter splits open (on chain) from signCommitment (off chain).
    // This test asserts a thousand commits never reach back into openChannel,
    // which is the load-bearing property of channel mode.
    // See docs/design.md, "The channel lifecycle manager".
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });

    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "10000",
      network: "testnet",
    });

    const COMMIT_COUNT = 1000;
    for (let i = 0; i < COMMIT_COUNT; i += 1) {
      await manager.commit(channel.id, "1");
    }

    expect(calls.openChannel).toHaveLength(1);
    expect(calls.signCommitment).toHaveLength(COMMIT_COUNT);

    const finalChannel = await manager.get(channel.id);
    expect(finalChannel?.committed).toBe(String(COMMIT_COUNT));
    expect(finalChannel?.sequence).toBe(COMMIT_COUNT - 1);
  });

  it("does not invoke any on-chain submission path during a long commit loop", async () => {
    // Stronger form: the adapter is wrapped with spies and any call to a
    // method other than signCommitment fails the test. The manager must
    // never reach into openChannel during a commit loop.
    const openChannel = vi.fn(async () => ({ channelId: "CSTRICT", openTxHash: "tx-strict" }));
    let runningCumulative = 0n;
    const signCommitment = vi.fn(async (input: SignCommitmentInput) => {
      runningCumulative = BigInt(input.cumulativeAmount);
      return { commitment: `sig:${input.cumulativeAmount}` };
    });
    const closeChannel = vi.fn(async () => ({
      settlementTxHash: "tx-close-strict",
      settledAmount: "0",
      returnedRemainder: "0",
    }));
    const adapter: MppChannelAdapter = { openChannel, signCommitment, closeChannel };

    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "10000",
      network: "testnet",
    });

    openChannel.mockClear();

    for (let i = 0; i < 250; i += 1) {
      await manager.commit(channel.id, "2");
    }

    expect(openChannel).not.toHaveBeenCalled();
    expect(closeChannel).not.toHaveBeenCalled();
    expect(signCommitment).toHaveBeenCalledTimes(250);
    expect(runningCumulative).toBe(500n);
  });
});

// ── shouldClose ───────────────────────────────────────────────────────────────

describe("ChannelManager.shouldClose", () => {
  it("returns false when no closePolicy is configured", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await manager.commit(channel.id, "999");
    expect(await manager.shouldClose(channel.id)).toBe(false);
  });

  it("returns true when committed reaches the drawdown threshold", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      closePolicy: { drawdownThreshold: 0.9 },
    });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await manager.commit(channel.id, "800");
    expect(await manager.shouldClose(channel.id)).toBe(false);

    await manager.commit(channel.id, "100");
    expect(await manager.shouldClose(channel.id)).toBe(true);
  });

  it("uses integer arithmetic so it tolerates large deposits without float error", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      closePolicy: { drawdownThreshold: 0.5 },
    });
    // 10^18 base units (plausible for tokens with 18 decimals); float math
    // would lose precision but the BigInt comparison must not.
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000000000000000000",
      network: "testnet",
    });

    await manager.commit(channel.id, "499999999999999999");
    expect(await manager.shouldClose(channel.id)).toBe(false);

    await manager.commit(channel.id, "1");
    expect(await manager.shouldClose(channel.id)).toBe(true);
  });

  it("returns true when the channel has been idle longer than the timeout", async () => {
    // Advance a controllable clock between open and the shouldClose check.
    let nowMs = Date.parse("2026-06-20T00:00:00Z");
    const now = () => new Date(nowMs).toISOString();

    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      closePolicy: { idleTimeoutSeconds: 60 },
      now,
    });

    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(channel.id, "100");

    // 59 seconds later, still inside the window.
    nowMs += 59_000;
    expect(await manager.shouldClose(channel.id)).toBe(false);

    // One more second pushes us past the timeout.
    nowMs += 1_000;
    expect(await manager.shouldClose(channel.id)).toBe(true);
  });

  it("uses the open timestamp as the idle baseline when no commit has landed", async () => {
    let nowMs = Date.parse("2026-06-20T00:00:00Z");
    const now = () => new Date(nowMs).toISOString();

    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      closePolicy: { idleTimeoutSeconds: 30 },
      now,
    });

    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    nowMs += 29_000;
    expect(await manager.shouldClose(channel.id)).toBe(false);

    nowMs += 2_000;
    expect(await manager.shouldClose(channel.id)).toBe(true);
  });

  it("returns true when either heuristic fires (drawdown wins)", async () => {
    let nowMs = Date.parse("2026-06-20T00:00:00Z");
    const now = () => new Date(nowMs).toISOString();

    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      closePolicy: { drawdownThreshold: 0.9, idleTimeoutSeconds: 3_600 },
      now,
    });

    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(channel.id, "950");
    nowMs += 10_000; // not idle

    expect(await manager.shouldClose(channel.id)).toBe(true);
  });

  it("returns true when either heuristic fires (idle wins)", async () => {
    let nowMs = Date.parse("2026-06-20T00:00:00Z");
    const now = () => new Date(nowMs).toISOString();

    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      closePolicy: { drawdownThreshold: 0.99, idleTimeoutSeconds: 60 },
      now,
    });

    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(channel.id, "10"); // well under drawdown
    nowMs += 61_000;

    expect(await manager.shouldClose(channel.id)).toBe(true);
  });

  it("returns false for any channel that is not open", async () => {
    const { adapter } = createFakeAdapter();
    const store = createMemoryCommitmentStore();
    const manager = createChannelManager({
      adapter,
      store,
      closePolicy: { drawdownThreshold: 0.1, idleTimeoutSeconds: 1 },
    });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await store.updateChannel(channel.id, { status: "closed" });
    expect(await manager.shouldClose(channel.id)).toBe(false);

    await store.updateChannel(channel.id, { status: "recovering" });
    expect(await manager.shouldClose(channel.id)).toBe(false);
  });

  it("throws ChannelNotFoundError for an unknown channel", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      closePolicy: { drawdownThreshold: 0.5 },
    });
    await expect(manager.shouldClose("CNOPE")).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it("rejects nonsensical policy values with InvalidAmountError", async () => {
    const { adapter } = createFakeAdapter();
    const channel = await createChannelManager({ adapter }).open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    // The first manager opened the channel; this one shares the same default
    // in-memory store only conceptually, so build a fresh manager for the
    // policy check that owns its own channel via the store.
    const store = createMemoryCommitmentStore();
    await store.putChannel({ ...channel });

    const negativeDrawdown = createChannelManager({
      adapter,
      store,
      closePolicy: { drawdownThreshold: -0.1 },
    });
    await expect(negativeDrawdown.shouldClose(channel.id)).rejects.toBeInstanceOf(
      InvalidAmountError,
    );

    const negativeIdle = createChannelManager({
      adapter,
      store,
      closePolicy: { idleTimeoutSeconds: -5 },
    });
    await expect(negativeIdle.shouldClose(channel.id)).rejects.toBeInstanceOf(InvalidAmountError);
  });
});

// ── close ─────────────────────────────────────────────────────────────────────

describe("ChannelManager.close", () => {
  it("submits a single settlement and reports the returned remainder", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await manager.commit(channel.id, "300");
    await manager.commit(channel.id, "400");

    const result = await manager.close(channel.id);

    expect(calls.closeChannel).toHaveLength(1);
    expect(calls.closeChannel[0]).toMatchObject({
      channelId: channel.id,
      cumulativeAmount: "700",
      deposit: "1000",
    });
    expect(result.channelId).toBe(channel.id);
    expect(result.settlementTxHash).toBe("tx-close-1");
    expect(result.returnedRemainder).toBe("300");

    const refreshed = await manager.get(channel.id);
    expect(refreshed?.status).toBe("closed");
    expect(refreshed?.settlementTxHash).toBe("tx-close-1");
    expect(refreshed?.returnedRemainder).toBe("300");
  });

  it("hands the adapter the latest commitment blob, not an earlier one", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await manager.commit(channel.id, "100");
    await manager.commit(channel.id, "100");
    const last = await manager.commit(channel.id, "100");

    await manager.close(channel.id);
    expect(calls.closeChannel[0]?.commitment).toBe(last.commitment);
    expect(calls.closeChannel[0]?.cumulativeAmount).toBe(last.cumulativeAmount);
  });

  it("returns the full deposit when no commitments were ever signed", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    const result = await manager.close(channel.id);

    expect(calls.closeChannel).toHaveLength(1);
    expect(calls.closeChannel[0]).toMatchObject({
      cumulativeAmount: "0",
      commitment: "",
    });
    expect(result.returnedRemainder).toBe("1000");
  });

  it("refuses to close an unknown channel", async () => {
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    await expect(manager.close("CNOPE")).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it("refuses to close a channel that is not open", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });

    await manager.close(channel.id);
    await expect(manager.close(channel.id)).rejects.toBeInstanceOf(ChannelAlreadyClosedError);
    // Adapter was called exactly once across the two close attempts.
    expect(calls.closeChannel).toHaveLength(1);
  });

  it("rolls the channel status back to open and surfaces the adapter error on failure", async () => {
    const sentinel = new Error("network unreachable");
    const { adapter, calls } = createFakeAdapter({
      close: () => {
        throw sentinel;
      },
    });
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(channel.id, "100");

    await expect(manager.close(channel.id)).rejects.toBe(sentinel);
    expect(calls.closeChannel).toHaveLength(1);

    const refreshed = await manager.get(channel.id);
    expect(refreshed?.status).toBe("open");
    expect(refreshed?.settlementTxHash).toBeUndefined();
  });

  it("throws SettlementMismatchError when the adapter under-settles the latest commitment", async () => {
    const { adapter } = createFakeAdapter({
      close: (input) => ({
        settlementTxHash: "tx-mismatch",
        settledAmount: "1", // ≠ requested cumulative
        returnedRemainder: BigInt(input.deposit).toString(),
      }),
    });
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(channel.id, "500");

    await expect(manager.close(channel.id)).rejects.toBeInstanceOf(SettlementMismatchError);
    const refreshed = await manager.get(channel.id);
    expect(refreshed?.status).toBe("open");
  });

  it("transitions through closing on the way to closed", async () => {
    const observedStatuses: string[] = [];
    const store = createMemoryCommitmentStore();
    const origUpdate = store.updateChannel.bind(store);
    store.updateChannel = async (id, patch) => {
      const next = await origUpdate(id, patch);
      if (next) observedStatuses.push(next.status);
      return next;
    };

    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter, store });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(channel.id, "100");

    observedStatuses.length = 0;
    await manager.close(channel.id);
    expect(observedStatuses).toContain("closing");
    expect(observedStatuses.at(-1)).toBe("closed");
  });
});

// ── high-frequency demo ───────────────────────────────────────────────────────

describe("high-frequency channel demo", () => {
  // Headline acceptance test for #34: hundreds of commitments off chain,
  // one close on chain. See docs/design.md, "The channel lifecycle manager".
  it("runs 500 commitments and one close, settling the full cumulative", async () => {
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({
      adapter,
      // 500 commits of 1000 land at 500_000 of 1_000_000 = 0.5 drawdown,
      // so a threshold of 0.5 fires exactly when the loop is done.
      closePolicy: { drawdownThreshold: 0.5 },
    });

    const channel = await manager.open({
      counterparty: "GRECIPIENT",
      asset: "USDC",
      deposit: "1000000",
      network: "testnet",
    });

    const COMMITS = 500;
    const PER_COMMIT = "1000";
    for (let i = 0; i < COMMITS; i += 1) {
      await manager.commit(channel.id, PER_COMMIT);
    }

    const closing = await manager.shouldClose(channel.id);
    expect(closing).toBe(true);

    const result = await manager.close(channel.id);

    expect(calls.openChannel).toHaveLength(1);
    expect(calls.signCommitment).toHaveLength(COMMITS);
    expect(calls.closeChannel).toHaveLength(1);
    expect(result.settlementTxHash).toBe("tx-close-1");
    expect(result.returnedRemainder).toBe("500000");

    const finalChannel = await manager.get(channel.id);
    expect(finalChannel?.status).toBe("closed");
    expect(finalChannel?.committed).toBe("500000");
    expect(finalChannel?.sequence).toBe(COMMITS - 1);
  });
});

// ── unimplemented surface ─────────────────────────────────────────────────────

describe("ChannelManager unimplemented methods", () => {
  let manager: ReturnType<typeof createChannelManager>;

  beforeEach(() => {
    const { adapter } = createFakeAdapter();
    manager = createChannelManager({ adapter });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recover throws NotImplementedError referencing the design doc", async () => {
    try {
      await manager.recover("CTEST001");
      expect.unreachable("expected recover to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).reference).toContain("design.md");
    }
  });
});

// ── typed error codes ─────────────────────────────────────────────────────────

describe("typed error codes are distinguishable on .code", () => {
  // Callers branch on TollwayError.code rather than parsing messages, so
  // every channel error class must report its own dedicated code. See
  // packages/core/src/errors.ts for the TollwayErrorCode union.
  it("ChannelNotFoundError reports code 'channel-not-found'", () => {
    expect(new ChannelNotFoundError("CTEST001").code).toBe("channel-not-found");
  });

  it("ChannelNotOpenError reports code 'channel-not-open'", () => {
    expect(new ChannelNotOpenError("CTEST001", "closed").code).toBe("channel-not-open");
  });

  it("ChannelAlreadyClosedError reports code 'channel-already-closed'", () => {
    expect(new ChannelAlreadyClosedError("CTEST001", "closed").code).toBe("channel-already-closed");
  });

  it("CommitmentExceedsDepositError reports code 'commitment-exceeds-deposit'", () => {
    expect(new CommitmentExceedsDepositError("CTEST001", "101", "100").code).toBe(
      "commitment-exceeds-deposit",
    );
  });

  it("SettlementMismatchError reports code 'settlement-mismatch'", () => {
    expect(new SettlementMismatchError("CTEST001", "100", "50").code).toBe("settlement-mismatch");
  });

  it("InvalidAmountError keeps code 'invalid-amount' for bad-amount inputs", () => {
    expect(new InvalidAmountError("oops", "deposit").code).toBe("invalid-amount");
  });

  it("the six channel error codes are pairwise distinct", () => {
    const codes = new Set([
      new ChannelNotFoundError("CTEST001").code,
      new ChannelNotOpenError("CTEST001", "closed").code,
      new ChannelAlreadyClosedError("CTEST001", "closed").code,
      new CommitmentExceedsDepositError("CTEST001", "101", "100").code,
      new SettlementMismatchError("CTEST001", "100", "50").code,
      new InvalidAmountError("oops", "deposit").code,
    ]);
    expect(codes.size).toBe(6);
  });
});
