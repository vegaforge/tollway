import { describe, expect, it } from "vitest";
import type { MppChannelAdapter, OpenAdapterInput, OpenAdapterResult } from "./adapter.js";
import { ChannelPoolExhaustedError, createChannelPool, type PoolFailure } from "./pool.js";
import { createChannelManager } from "./manager.js";

/**
 * A channel pool (#188) leases several channels per counterparty and asset,
 * so one payment's commit never waits behind another on the same channel.
 */

const USDC = "CUSDC";
const COUNTERPARTY = "GCOUNTERPARTY";

function fakeAdapter(options: { failOpen?: boolean } = {}) {
  const opens: OpenAdapterInput[] = [];
  let count = 0;
  const adapter: MppChannelAdapter = {
    async openChannel(input): Promise<OpenAdapterResult> {
      opens.push(input);
      if (options.failOpen) throw new Error("rpc unavailable");
      count += 1;
      return { channelId: `CPOOL${String(count).padStart(3, "0")}`, openTxHash: `tx-${count}` };
    },
    async getChannelState() {
      return { balance: "1000000", currentLedger: 1 };
    },
    async findChannelSettlement() {
      return null;
    },
    async signCommitment(input) {
      return { commitment: `sig:${input.channelId}:${input.cumulativeAmount}` };
    },
    async closeChannel(input) {
      return {
        settlementTxHash: `close-${input.channelId}`,
        settledAmount: input.cumulativeAmount,
        returnedRemainder: "0",
      };
    },
    async startClose() {
      throw new Error("not used by the pool tests");
    },
    async refund() {
      throw new Error("not used by the pool tests");
    },
  };
  return { adapter, opens };
}

function poolOver(
  manager: ReturnType<typeof createChannelManager>,
  overrides: Partial<Parameters<typeof createChannelPool>[0]> = {},
) {
  const failures: PoolFailure[] = [];
  const pool = createChannelPool({
    manager,
    network: "testnet",
    deposit: "1000",
    rotateBelow: "300",
    maxChannelsPerKey: 1,
    maxLockedDeposit: "100000",
    selection: "least-drawn",
    acquireTimeoutMs: 20,
    leaseTimeoutMs: 60_000,
    onFailure: (failure) => failures.push(failure),
    ...overrides,
  });
  return { pool, failures };
}

describe("ChannelPool.acquire and release", () => {
  it("opens a channel for the first acquire and leases it", async () => {
    const { adapter } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool } = poolOver(manager);

    const lease = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    expect(lease.channelId).toBe("CPOOL001");
    await pool.release(lease);
  });

  it("never hands one channel to two concurrent leases", async () => {
    const { adapter, opens } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool } = poolOver(manager, { acquireTimeoutMs: 1_000 });

    const first = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });
    const second = pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });
    await pool.release(first);
    const reused = await second;

    expect(reused.channelId).toBe(first.channelId);
    expect(opens).toHaveLength(1);
    await pool.release(reused);
  });

  it("opens one channel per concurrent lease and never the same channel twice", async () => {
    const { adapter, opens } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool } = poolOver(manager, { maxChannelsPerKey: 3 });

    const leases = await Promise.all(
      [1, 2, 3].map(() => pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" })),
    );

    expect(new Set(leases.map((lease) => lease.channelId)).size).toBe(3);
    expect(opens).toHaveLength(3);
  });

  it("rejects with ChannelPoolExhaustedError when the limit is reached and no lease comes back in time", async () => {
    const { adapter } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool } = poolOver(manager, { maxChannelsPerKey: 1, acquireTimeoutMs: 20 });
    await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    const attempt = pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    await expect(attempt).rejects.toBeInstanceOf(ChannelPoolExhaustedError);
    await expect(attempt).rejects.toMatchObject({ code: "channel-pool-exhausted" });
  });

  it("does not open a channel that would take the pool past its locked deposit", async () => {
    const { adapter, opens } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool } = poolOver(manager, {
      maxChannelsPerKey: 5,
      deposit: "1000",
      maxLockedDeposit: "1500",
    });
    await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    await expect(
      pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" }),
    ).rejects.toBeInstanceOf(ChannelPoolExhaustedError);
    expect(opens).toHaveLength(1);
  });

  it("reclaims a lease its holder never released once the lease timeout passes", async () => {
    const { adapter, opens } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool } = poolOver(manager, { leaseTimeoutMs: 10 });
    const leaked = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const next = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    expect(next.channelId).toBe(leaked.channelId);
    expect(opens).toHaveLength(1);
    await pool.release(leaked);
  });
});

describe("ChannelPool rotation and membership", () => {
  it("opens a replacement before the old channel runs out and stops leasing the old one", async () => {
    const { adapter, opens } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool } = poolOver(manager, {
      deposit: "1000",
      rotateBelow: "300",
      maxChannelsPerKey: 2,
    });
    const first = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "800" });
    await manager.commit(first.channelId, "800");
    await pool.release(first);

    const next = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "500" });

    expect(next.channelId).not.toBe(first.channelId);
    expect(opens).toHaveLength(2);
    await pool.release(next);
  });

  it("rebuilds its membership from the store, so a restart reuses the open channel", async () => {
    const { adapter, opens } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const existing = await manager.open({
      counterparty: COUNTERPARTY,
      asset: USDC,
      deposit: "1000",
      network: "testnet",
    });
    const { pool } = poolOver(manager);

    const lease = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    expect(lease.channelId).toBe(existing.id);
    expect(opens).toHaveLength(1);
    await pool.release(lease);
  });

  it("drops a channel the service reports closed and reports it through onFailure", async () => {
    const { adapter } = fakeAdapter();
    const manager = createChannelManager({ adapter });
    const { pool, failures } = poolOver(manager);
    const first = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });
    await pool.release(first);
    await manager.close(first.channelId);

    const next = await pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" });

    expect(next.channelId).not.toBe(first.channelId);
    expect(failures).toEqual([
      expect.objectContaining({ kind: "channel-closed", channelId: first.channelId }),
    ]);
    await pool.release(next);
  });

  it("reports a failed open and rejects the acquire that needed the channel", async () => {
    const { adapter } = fakeAdapter({ failOpen: true });
    const manager = createChannelManager({ adapter });
    const { pool, failures } = poolOver(manager);

    await expect(
      pool.acquire({ counterparty: COUNTERPARTY, asset: USDC, amount: "100" }),
    ).rejects.toThrow("rpc unavailable");
    expect(failures).toEqual([expect.objectContaining({ kind: "open-failed" })]);
  });
});
