import {
  type CounterpartyQuarantine,
  createMemoryQuarantine,
  NotImplementedError,
} from "@vegaforge/tollway-core";
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
  CloseNotSubmittedError,
  CommitmentConflictError,
  CommitmentExceedsDepositError,
  CounterpartyQuarantinedError,
  InvalidAmountError,
  MissingEventHistoryError,
  SettlementMismatchError,
  SettlementNotFoundError,
} from "./errors.js";
import { createChannelManager } from "./manager.js";
import { createMemoryCommitmentStore } from "./store.js";
import type { Commitment } from "./types.js";

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

  let ledger = 100_000;
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
    async getChannelState() {
      ledger += 1;
      return { balance: "1000", currentLedger: ledger };
    },
    async findChannelSettlement() {
      return null;
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
    const adapter: MppChannelAdapter = {
      openChannel,
      signCommitment,
      closeChannel,
      async getChannelState() {
        return { balance: "0", currentLedger: 100_000 };
      },
      async findChannelSettlement() {
        return null;
      },
    };

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

  it("keeps the channel in closing on an adapter error so resume can ask the chain (Issue #176)", async () => {
    // Pre-#176 behaviour rolled back to "open" here, which could make
    // the manager sign a second close for a payment that had already
    // landed. The new contract: an adapter error after the attempt was
    // recorded is indeterminate, so the channel stays in `closing`
    // with the close attempt recorded for `resume()` to inspect.
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
    expect(refreshed?.status).toBe("closing");
    expect(refreshed?.closeAttempt).toBeDefined();
    expect(refreshed?.settlementTxHash).toBeUndefined();
  });

  it("moves the channel to settlement-mismatched (terminal) when the adapter under-settles (Issue #176)", async () => {
    // Pre-#176 behaviour rolled back to "open" here, letting the agent
    // sign over a chain state that no longer agreed with the commitment
    // stream. The new contract: the mismatch is terminal and the
    // channel never reopens for commits.
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
    expect(refreshed?.status).toBe("settlement-mismatched");
    expect(refreshed?.settlementMismatch).toEqual({
      expectedAmount: "500",
      observedAmount: "1",
    });
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
    // The move to closing is a compare-and-set (#175), so watch that write too.
    const origTransition = store.transitionChannel.bind(store);
    store.transitionChannel = async (id, expectedStatus, patch) => {
      const next = await origTransition(id, expectedStatus, patch);
      observedStatuses.push(next.status);
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

  it("CounterpartyQuarantinedError reports code 'counterparty-quarantined'", () => {
    expect(new CounterpartyQuarantinedError("GRECIPIENT", "under-settled").code).toBe(
      "counterparty-quarantined",
    );
  });

  it("the seven channel error codes are pairwise distinct", () => {
    const codes = new Set([
      new ChannelNotFoundError("CTEST001").code,
      new ChannelNotOpenError("CTEST001", "closed").code,
      new ChannelAlreadyClosedError("CTEST001", "closed").code,
      new CommitmentExceedsDepositError("CTEST001", "101", "100").code,
      new SettlementMismatchError("CTEST001", "100", "50").code,
      new InvalidAmountError("oops", "deposit").code,
      new CounterpartyQuarantinedError("GRECIPIENT", "under-settled").code,
    ]);
    expect(codes.size).toBe(7);
  });
});

// ── quarantine ────────────────────────────────────────────────────────────────

describe("ChannelManager quarantine", () => {
  it("refuses open and commit for a quarantined counterparty while allowing close", async () => {
    const quarantine = createMemoryQuarantine();
    const { adapter, calls } = createFakeAdapter();
    const manager = createChannelManager({ adapter, quarantine });

    const channel = await manager.open({
      counterparty: "GRECIPIENT",
      asset: "USDC:GA5Z",
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(channel.id, "200");

    await quarantine.quarantine({
      counterparty: "GRECIPIENT",
      reason: "under-settled",
      drift: { kind: "under-settled", detail: "shortfall 100", channelId: channel.id },
    });

    await expect(
      manager.open({
        counterparty: "GRECIPIENT",
        asset: "USDC:GA5Z",
        deposit: "1000",
        network: "testnet",
      }),
    ).rejects.toMatchObject({ code: "counterparty-quarantined" });

    await expect(manager.commit(channel.id, "100")).rejects.toMatchObject({
      code: "counterparty-quarantined",
    });

    // Adapter should not have been called for the refused open/commit.
    expect(calls.openChannel).toHaveLength(1);
    expect(calls.signCommitment).toHaveLength(1);

    // Close stays allowed so funds can be settled or recovered.
    const closed = await manager.close(channel.id);
    expect(closed.channelId).toBe(channel.id);
    expect(calls.closeChannel).toHaveLength(1);
  });

  it("restores open and commit after explicit release", async () => {
    const quarantine = createMemoryQuarantine();
    const { adapter } = createFakeAdapter();
    const manager = createChannelManager({ adapter, quarantine });

    const channel = await manager.open({
      counterparty: "GRECIPIENT",
      asset: "USDC:GA5Z",
      deposit: "1000",
      network: "testnet",
    });

    await quarantine.quarantine({
      counterparty: "GRECIPIENT",
      reason: "under-settled",
      drift: { kind: "under-settled", detail: "shortfall 100" },
    });
    await expect(manager.commit(channel.id, "100")).rejects.toBeInstanceOf(
      CounterpartyQuarantinedError,
    );

    await quarantine.release({ counterparty: "GRECIPIENT", releasedBy: "operator" });

    const commitment = await manager.commit(channel.id, "100");
    expect(commitment.cumulativeAmount).toBe("100");
  });

  it("fails closed on open and commit when quarantine lookup fails", async () => {
    const failingQuarantine: CounterpartyQuarantine = {
      async quarantine() {
        throw new Error("unreachable");
      },
      async release() {
        throw new Error("unreachable");
      },
      async lookup() {
        throw new Error("quarantine store unavailable");
      },
      async history() {
        return [];
      },
    };
    const { adapter } = createFakeAdapter();
    const store = createMemoryCommitmentStore();
    await store.putChannel({
      id: "CTEST001",
      counterparty: "GRECIPIENT",
      asset: "USDC:GA5Z",
      deposit: "1000",
      committed: "0",
      sequence: -1,
      status: "open",
      network: "testnet",
      openTxHash: "tx-open-1",
      openedAt: "2026-11-24T08:00:00.000Z",
    });

    const manager = createChannelManager({
      adapter,
      store,
      quarantine: failingQuarantine,
    });

    await expect(
      manager.open({
        counterparty: "GRECIPIENT",
        asset: "USDC:GA5Z",
        deposit: "1000",
        network: "testnet",
      }),
    ).rejects.toMatchObject({ code: "counterparty-quarantined" });

    await expect(manager.commit("CTEST001", "100")).rejects.toMatchObject({
      code: "counterparty-quarantined",
    });
  });
});

// Issue #176 coverage for the resume path.
describe("ChannelManager.resume (Issue #176)", () => {
  function fakeAdapterWithChain(
    chain: {
      state: { balance: string; closeEffectiveAtLedger?: number; currentLedger: number };
      settlement?: {
        settlementTxHash: string;
        settledAmount: string;
        returnedRemainder: string;
        settledAtLedger: number;
      };
    },
    overrides: {
      close?: (input: CloseAdapterInput) => CloseAdapterResult | Promise<CloseAdapterResult>;
    } = {},
  ): { adapter: MppChannelAdapter; calls: { close: number; find: number } } {
    const calls = { close: 0, find: 0 };
    let openCount = 0;
    return {
      adapter: {
        async openChannel() {
          openCount += 1;
          return {
            channelId: `CTEST${openCount.toString().padStart(3, "0")}`,
            openTxHash: `tx-open-${openCount}`,
          };
        },
        async signCommitment(input) {
          return { commitment: `sig:${input.cumulativeAmount}` };
        },
        async closeChannel(input) {
          calls.close += 1;
          if (overrides.close) return overrides.close(input);
          return {
            settlementTxHash: "tx-close",
            settledAmount: input.cumulativeAmount,
            returnedRemainder: (BigInt(input.deposit) - BigInt(input.cumulativeAmount)).toString(),
          };
        },
        async getChannelState() {
          return chain.state;
        },
        async findChannelSettlement() {
          calls.find += 1;
          return chain.settlement ?? null;
        },
      },
      calls,
    };
  }

  it("resume on a channel stuck in closing retries close when nothing is on chain yet", async () => {
    // Build a manager whose close() throws, then run resume() against the
    // same store with a new adapter that completes close() cleanly.
    const store = createMemoryCommitmentStore();
    const { adapter: failing } = fakeAdapterWithChain(
      {
        state: { balance: "1000", currentLedger: 100 },
      },
      {
        close: () => {
          throw new Error("submit timed out");
        },
      },
    );
    const mgr1 = createChannelManager({ adapter: failing, store });
    const channel = await mgr1.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await mgr1.commit(channel.id, "200");
    await expect(mgr1.close(channel.id)).rejects.toThrow();

    const { adapter: healthy, calls } = fakeAdapterWithChain({
      state: { balance: "1000", currentLedger: 150 },
    });
    const mgr2 = createChannelManager({ adapter: healthy, store });
    const outcome = await mgr2.resume(channel.id);
    expect(outcome.kind).toBe("reclosed");
    expect(calls.close).toBe(1);
    const refreshed = await mgr2.get(channel.id);
    expect(refreshed?.status).toBe("closed");
  });

  it("resume on a channel whose close already landed fetches settlement details and marks closed", async () => {
    const store = createMemoryCommitmentStore();
    const { adapter: failing } = fakeAdapterWithChain(
      { state: { balance: "1000", currentLedger: 100 } },
      {
        close: () => {
          throw new Error("poll timeout");
        },
      },
    );
    const mgr1 = createChannelManager({ adapter: failing, store });
    const channel = await mgr1.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await mgr1.commit(channel.id, "400");
    await expect(mgr1.close(channel.id)).rejects.toThrow();

    const { adapter: resolved, calls } = fakeAdapterWithChain({
      state: { balance: "0", closeEffectiveAtLedger: 120, currentLedger: 150 },
      settlement: {
        settlementTxHash: "tx-landed",
        settledAmount: "400",
        returnedRemainder: "600",
        settledAtLedger: 120,
      },
    });
    const mgr2 = createChannelManager({ adapter: resolved, store });
    const outcome = await mgr2.resume(channel.id);
    expect(outcome.kind).toBe("closed");
    if (outcome.kind !== "closed") throw new Error("expected closed");
    expect(outcome.settlementTxHash).toBe("tx-landed");
    expect(outcome.returnedRemainder).toBe("600");
    expect(calls.find).toBe(1);
    const refreshed = await mgr2.get(channel.id);
    expect(refreshed?.status).toBe("closed");
  });

  it("resume hands a non-zero-balance close to the recovery path", async () => {
    const store = createMemoryCommitmentStore();
    const { adapter: failing } = fakeAdapterWithChain(
      { state: { balance: "1000", currentLedger: 100 } },
      {
        close: () => {
          throw new Error("poll timeout");
        },
      },
    );
    const mgr1 = createChannelManager({ adapter: failing, store });
    const channel = await mgr1.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await mgr1.commit(channel.id, "400");
    await expect(mgr1.close(channel.id)).rejects.toThrow();

    const { adapter: funderInitiated } = fakeAdapterWithChain({
      state: { balance: "600", closeEffectiveAtLedger: 160, currentLedger: 180 },
    });
    const mgr2 = createChannelManager({ adapter: funderInitiated, store });
    const outcome = await mgr2.resume(channel.id);
    expect(outcome.kind).toBe("recovering");
    const refreshed = await mgr2.get(channel.id);
    expect(refreshed?.status).toBe("recovering");
  });

  it("resume is a no-op for a channel that never started closing", async () => {
    const { adapter } = fakeAdapterWithChain({
      state: { balance: "1000", currentLedger: 100 },
    });
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    const outcome = await manager.resume(channel.id);
    expect(outcome.kind).toBe("no-change");
  });

  it("resumeAll resumes every closing channel and reports per-channel outcomes", async () => {
    const store = createMemoryCommitmentStore();
    const { adapter: failing } = fakeAdapterWithChain(
      { state: { balance: "1000", currentLedger: 100 } },
      {
        close: () => {
          throw new Error("poll timeout");
        },
      },
    );
    const mgr1 = createChannelManager({ adapter: failing, store });
    const cA = await mgr1.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await mgr1.commit(cA.id, "100");
    await expect(mgr1.close(cA.id)).rejects.toThrow();
    const cB = await mgr1.open({
      counterparty: "GS",
      asset: "USDC",
      deposit: "1000",
      network: "testnet",
    });
    await mgr1.commit(cB.id, "200");
    await expect(mgr1.close(cB.id)).rejects.toThrow();

    const { adapter: healthy } = fakeAdapterWithChain({
      state: { balance: "1000", currentLedger: 200 },
    });
    const mgr2 = createChannelManager({ adapter: healthy, store });
    const result = await mgr2.resumeAll();
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.kind === "reclosed")).toBe(true);
  });
});

// ── crash safety (#176) ──────────────────────────────────────────────────────

/**
 * A fake chain shared by every adapter built over it, so a second manager
 * (a restarted process) sees what the first one submitted. Each channel
 * holds a deposit; a submitted close empties it and leaves a settlement.
 */
function createFakeChain() {
  type ChainChannel = {
    balance: bigint;
    closeEffectiveAtLedger?: number;
    settlement?: {
      settlementTxHash: string;
      settledAmount: string;
      returnedRemainder: string;
      settledAtLedger: number;
    };
  };
  const channels = new Map<string, ChainChannel>();
  const calls = { submitted: 0, find: [] as number[] };
  let ledger = 1_000;
  let opened = 0;

  function adapter(
    behaviour: {
      /** Throw after the close landed on chain, like a poll timeout. */
      loseAnswer?: boolean;
      /** Make the next close wait until this resolves. */
      gate?: Promise<void>;
      findSettlement?: (startLedger: number) => Promise<void>;
    } = {},
  ): MppChannelAdapter {
    return {
      async openChannel(input) {
        opened += 1;
        const id = `CCHAIN${opened}`;
        channels.set(id, { balance: BigInt(input.deposit) });
        return { channelId: id, openTxHash: `tx-open-${opened}` };
      },
      async signCommitment(input) {
        return { commitment: `sig:${input.cumulativeAmount}` };
      },
      async getChannelState({ channelId }) {
        const channel = channels.get(channelId);
        if (!channel) throw new Error(`no channel ${channelId} on chain`);
        ledger += 1;
        return {
          balance: channel.balance.toString(),
          currentLedger: ledger,
          ...(channel.closeEffectiveAtLedger === undefined
            ? {}
            : { closeEffectiveAtLedger: channel.closeEffectiveAtLedger }),
        };
      },
      async closeChannel(input) {
        await behaviour.gate;
        const channel = channels.get(input.channelId);
        if (!channel) throw new Error("no channel");
        calls.submitted += 1;
        ledger += 1;
        const settlement = {
          settlementTxHash: `tx-close-${calls.submitted}`,
          settledAmount: input.cumulativeAmount,
          returnedRemainder: (channel.balance - BigInt(input.cumulativeAmount)).toString(),
          settledAtLedger: ledger,
        };
        channel.balance = 0n;
        channel.closeEffectiveAtLedger = ledger;
        channel.settlement = settlement;
        if (behaviour.loseAnswer) throw new Error("PollTimeoutError: no final status");
        const { settledAtLedger: _ledger, ...result } = settlement;
        return result;
      },
      async findChannelSettlement({ channelId, startLedger }) {
        calls.find.push(startLedger);
        await behaviour.findSettlement?.(startLedger);
        const settlement = channels.get(channelId)?.settlement;
        return settlement && settlement.settledAtLedger >= startLedger ? settlement : null;
      },
    };
  }

  return { adapter, channels, calls };
}

async function openWithCommit(
  manager: ReturnType<typeof createChannelManager>,
  amount = "400",
): Promise<string> {
  const channel = await manager.open({
    counterparty: "GR",
    asset: "USDC",
    deposit: "1000",
    network: "testnet",
  });
  await manager.commit(channel.id, amount);
  return channel.id;
}

describe("ChannelManager close crash safety (#176)", () => {
  it("records the close attempt before submitting, with the injected clock", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const observed: unknown[] = [];
    const base = chain.adapter();
    const adapter: MppChannelAdapter = {
      ...base,
      async closeChannel(input) {
        observed.push((await store.getChannel(input.channelId))?.closeAttempt);
        return base.closeChannel(input);
      },
    };
    const manager = createChannelManager({
      adapter,
      store,
      now: () => "2026-11-23T12:00:00.000Z",
    });
    const id = await openWithCommit(manager);
    await manager.close(id);
    expect(observed).toEqual([
      {
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        startedAtLedger: expect.any(Number),
        startedAt: "2026-11-23T12:00:00.000Z",
      },
    ]);
  });

  it("leaves the channel open when the chain cannot be read before closing", async () => {
    const chain = createFakeChain();
    const base = chain.adapter();
    const adapter: MppChannelAdapter = {
      ...base,
      async getChannelState() {
        throw new Error("RPC unreachable");
      },
    };
    const manager = createChannelManager({ adapter });
    const id = await openWithCommit(manager);
    await expect(manager.close(id)).rejects.toThrow("RPC unreachable");
    const channel = await manager.get(id);
    expect(channel?.status).toBe("open");
    expect(channel?.closeAttempt).toBeUndefined();
    expect(chain.calls.submitted).toBe(0);
  });

  it("returns the channel to open, without an attempt, when the adapter says nothing was submitted", async () => {
    const chain = createFakeChain();
    const base = chain.adapter();
    const adapter: MppChannelAdapter = {
      ...base,
      async closeChannel(input) {
        throw new CloseNotSubmittedError(input.channelId, new Error("malformed commitment"));
      },
    };
    const manager = createChannelManager({ adapter });
    const id = await openWithCommit(manager);
    await expect(manager.close(id)).rejects.toBeInstanceOf(CloseNotSubmittedError);
    const channel = await manager.get(id);
    expect(channel?.status).toBe("open");
    expect(channel?.closeAttempt).toBeUndefined();
    // Still usable: the next commit goes through.
    await expect(manager.commit(id, "500")).resolves.toBeDefined();
  });

  it("survives a crash mid-close: a restarted manager finds the landed settlement", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const first = createChannelManager({ adapter: chain.adapter({ loseAnswer: true }), store });
    const id = await openWithCommit(first, "400");
    await expect(first.close(id)).rejects.toThrow("PollTimeoutError");
    const stuck = await store.getChannel(id);
    expect(stuck?.status).toBe("closing");

    // A new process over the same store and the same chain.
    const second = createChannelManager({ adapter: chain.adapter(), store });
    const outcome = await second.resume(id);
    expect(outcome).toEqual({
      kind: "closed",
      channelId: id,
      settlementTxHash: "tx-close-1",
      returnedRemainder: "600",
    });
    expect(chain.calls.submitted).toBe(1);
    // The lookup starts where the attempt started, not at the close.
    expect(chain.calls.find).toEqual([stuck?.closeAttempt?.startedAtLedger]);
    expect(await second.get(id)).toMatchObject({
      status: "closed",
      settlementTxHash: "tx-close-1",
      returnedRemainder: "600",
    });
  });

  it("fails loudly, and stays closing, when the chain is closed but no settlement is found", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const first = createChannelManager({ adapter: chain.adapter({ loseAnswer: true }), store });
    const id = await openWithCommit(first);
    await expect(first.close(id)).rejects.toThrow();
    const onChain = chain.channels.get(id);
    if (onChain) delete onChain.settlement;

    const second = createChannelManager({ adapter: chain.adapter(), store });
    await expect(second.resume(id)).rejects.toBeInstanceOf(SettlementNotFoundError);
    expect((await store.getChannel(id))?.status).toBe("closing");
  });

  it("fails loudly, and stays closing, when the chain's history no longer reaches the attempt", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const first = createChannelManager({ adapter: chain.adapter({ loseAnswer: true }), store });
    const id = await openWithCommit(first);
    await expect(first.close(id)).rejects.toThrow();

    const second = createChannelManager({
      adapter: chain.adapter({
        findSettlement: async (startLedger) => {
          throw new MissingEventHistoryError(id, startLedger);
        },
      }),
      store,
    });
    await expect(second.resume(id)).rejects.toBeInstanceOf(MissingEventHistoryError);
    expect((await store.getChannel(id))?.status).toBe("closing");
  });

  it("flags a settlement found on resume that differs from the last commitment", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const first = createChannelManager({ adapter: chain.adapter({ loseAnswer: true }), store });
    const id = await openWithCommit(first, "400");
    await expect(first.close(id)).rejects.toThrow();
    const landed = chain.channels.get(id)?.settlement;
    if (landed) landed.settledAmount = "300";

    const second = createChannelManager({ adapter: chain.adapter(), store });
    await expect(second.resume(id)).rejects.toBeInstanceOf(SettlementMismatchError);
    expect(await second.get(id)).toMatchObject({
      status: "settlement-mismatched",
      settlementMismatch: { expectedAmount: "400", observedAmount: "300" },
    });
    // Terminal: never reopened for commits, never resumed again.
    await expect(second.commit(id, "500")).rejects.toBeInstanceOf(ChannelNotOpenError);
    expect(await second.resume(id)).toMatchObject({ kind: "no-change" });
  });

  it("is idempotent: a second resume changes nothing and submits nothing", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const first = createChannelManager({ adapter: chain.adapter({ loseAnswer: true }), store });
    const id = await openWithCommit(first);
    await expect(first.close(id)).rejects.toThrow();
    const second = createChannelManager({ adapter: chain.adapter(), store });
    await second.resume(id);
    const after = await store.getChannel(id);
    expect(await second.resume(id)).toEqual({ kind: "no-change", channelId: id, status: "closed" });
    expect(await store.getChannel(id)).toEqual(after);
    expect(chain.calls.submitted).toBe(1);
  });

  it("submits one close for concurrent resumes of the same channel in one process", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const first = createChannelManager({
      adapter: {
        ...chain.adapter(),
        async closeChannel(input) {
          throw new Error(`timed out before submitting ${input.channelId}`);
        },
      },
      store,
    });
    const id = await openWithCommit(first);
    await expect(first.close(id)).rejects.toThrow();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const second = createChannelManager({ adapter: chain.adapter({ gate }), store });
    const runs = [second.resume(id), second.resume(id), second.resume(id)];
    release();
    const outcomes = await Promise.all(runs);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["reclosed", "reclosed", "reclosed"]);
    expect(chain.calls.submitted).toBe(1);
  });

  it("resumeAll reports each channel's result and does not stop at a failure", async () => {
    const chain = createFakeChain();
    const store = createMemoryCommitmentStore();
    const first = createChannelManager({ adapter: chain.adapter({ loseAnswer: true }), store });
    const landed = await openWithCommit(first, "100");
    const lost = await openWithCommit(first, "200");
    const funder = await openWithCommit(first, "300");
    for (const id of [landed, lost, funder]) await expect(first.close(id)).rejects.toThrow();
    const lostChannel = chain.channels.get(lost);
    if (lostChannel) delete lostChannel.settlement;
    const funderChannel = chain.channels.get(funder);
    if (funderChannel) funderChannel.balance = 700n;

    const second = createChannelManager({ adapter: chain.adapter(), store });
    const { outcomes } = await second.resumeAll();
    const byChannel = new Map(outcomes.map((outcome) => [outcome.channelId, outcome]));
    expect(byChannel.get(landed)).toMatchObject({ kind: "closed" });
    expect(byChannel.get(lost)).toMatchObject({ kind: "error" });
    expect((byChannel.get(lost) as { error: Error }).error).toBeInstanceOf(SettlementNotFoundError);
    expect(byChannel.get(funder)).toMatchObject({ kind: "recovering" });
  });
});

// ── concurrent writers (#175) ─────────────────────────────────────────────────

function slowSign(ms: number): Parameters<typeof createFakeAdapter>[0] {
  return {
    sign: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { commitment: `sig:${input.channelId}:${input.cumulativeAmount}` };
    },
  };
}

describe("ChannelManager concurrent writers (#175)", () => {
  it("never writes two commitments with one sequence when commits race", async () => {
    // Three commits read the same channel state, then sign for 5 ms each.
    // Before the compare-and-set, all three resolved with sequence 0 and
    // cumulative 150 was recorded against a deposit of 100.
    const { adapter } = createFakeAdapter(slowSign(5));
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "100",
      network: "testnet",
    });

    const results = await Promise.allSettled([
      manager.commit(channel.id, "60"),
      manager.commit(channel.id, "60"),
      manager.commit(channel.id, "30"),
    ]);
    const accepted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const rejected = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const reason of rejected) expect(reason).toBeInstanceOf(CommitmentConflictError);

    const stream = await manager.list(channel.id);
    expect(stream.map((c) => c.sequence)).toEqual([0]);
    expect(stream[0]?.cumulativeAmount).toBe(accepted[0]?.cumulativeAmount);
    expect((await manager.get(channel.id))?.committed).toBe(accepted[0]?.cumulativeAmount);
    expect((await manager.get(channel.id))?.sequence).toBe(0);
  });

  it("submits one close when two closes race", async () => {
    // Before the status compare-and-set, both closes passed the status check
    // and both submitted closeChannel.
    const { adapter, calls } = createFakeAdapter(slowSign(0));
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "100",
      network: "testnet",
    });
    await manager.commit(channel.id, "40");

    const results = await Promise.allSettled([
      manager.close(channel.id),
      manager.close(channel.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const losing = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(losing).toHaveLength(1);
    expect(losing[0]).toBeInstanceOf(ChannelAlreadyClosedError);
    expect(calls.closeChannel).toHaveLength(1);
  });

  it("settles with the last recorded commitment when a commit races a close", async () => {
    // Whichever of the two wins, the close must settle the cumulative amount
    // that is in the stream at the time it was submitted, never an older one.
    const { adapter, calls } = createFakeAdapter(slowSign(2));
    const manager = createChannelManager({ adapter });
    const channel = await manager.open({
      counterparty: "GR",
      asset: "USDC",
      deposit: "100",
      network: "testnet",
    });
    await manager.commit(channel.id, "40");

    await Promise.allSettled([manager.close(channel.id), manager.commit(channel.id, "10")]);

    const stream: readonly Commitment[] = await manager.list(channel.id);
    const last = stream.at(-1);
    expect(calls.closeChannel).toHaveLength(1);
    expect(calls.closeChannel[0]?.cumulativeAmount).toBe(last?.cumulativeAmount);
  });
});

// ── listChannels ─────────────────────────────────────────────────────────────

describe("ChannelManager.listChannels", () => {
  function managerWithClock(adapter: MppChannelAdapter) {
    let tick = 0;
    return createChannelManager({
      adapter,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    });
  }

  it("lists tracked channels newest first and forwards filters and paging", async () => {
    const { adapter } = createFakeAdapter();
    const manager = managerWithClock(adapter);

    for (const counterparty of ["GONE", "GTWO", "GTHREE"]) {
      await manager.open({
        counterparty,
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        deposit: "10000000",
        network: "testnet",
      });
    }

    const all = await manager.listChannels();
    expect(all.channels.map((channel) => channel.id)).toEqual(["CTEST003", "CTEST002", "CTEST001"]);

    const filtered = await manager.listChannels({ counterparty: "GTWO" });
    expect(filtered.channels.map((channel) => channel.id)).toEqual(["CTEST002"]);

    const first = await manager.listChannels({ limit: 1 });
    expect(first.channels.map((channel) => channel.id)).toEqual(["CTEST003"]);
    const second = await manager.listChannels({ limit: 1, cursor: first.nextCursor });
    expect(second.channels.map((channel) => channel.id)).toEqual(["CTEST002"]);
  });
});
