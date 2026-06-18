import { NotImplementedError } from "@tollway/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MppChannelAdapter,
  OpenAdapterInput,
  OpenAdapterResult,
  SignCommitmentInput,
  SignedCommitment,
} from "./adapter.js";
import {
  ChannelNotFoundError,
  ChannelNotOpenError,
  CommitmentExceedsDepositError,
  InvalidAmountError,
} from "./errors.js";
import { createChannelManager } from "./manager.js";
import { createMemoryCommitmentStore } from "./store.js";

// ── test double ───────────────────────────────────────────────────────────────

type FakeAdapterCalls = {
  openChannel: OpenAdapterInput[];
  signCommitment: SignCommitmentInput[];
};

function createFakeAdapter(overrides?: {
  open?: (input: OpenAdapterInput) => OpenAdapterResult | Promise<OpenAdapterResult>;
  sign?: (input: SignCommitmentInput) => SignedCommitment | Promise<SignedCommitment>;
}): { adapter: MppChannelAdapter; calls: FakeAdapterCalls } {
  const calls: FakeAdapterCalls = { openChannel: [], signCommitment: [] };
  let openCount = 0;

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
    const adapter: MppChannelAdapter = { openChannel, signCommitment };

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
    expect(signCommitment).toHaveBeenCalledTimes(250);
    expect(runningCumulative).toBe(500n);
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

  it("shouldClose throws NotImplementedError referencing the design doc", async () => {
    try {
      await manager.shouldClose("CTEST001");
      expect.unreachable("expected shouldClose to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).reference).toContain("design.md");
    }
  });

  it("close throws NotImplementedError", async () => {
    await expect(manager.close("CTEST001")).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("recover throws NotImplementedError", async () => {
    await expect(manager.recover("CTEST001")).rejects.toBeInstanceOf(NotImplementedError);
  });
});
