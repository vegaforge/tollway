import { describe, expect, it, vi } from "vitest";
import {
  createChannelWatchtower,
  type ChannelWatchRpc,
  type WatchtowerChannel,
} from "./channel-watchtower.js";

const channel: WatchtowerChannel = {
  channelId: "CCHANNEL",
  network: "testnet",
  refundWaitingPeriod: 20,
  voucher: { cumulativeAmount: "42", commitment: "sig" },
};

function harness() {
  let event:
    | ((value: {
        type: "close_start" | "close";
        effectiveAtLedger: number;
        currentLedger: number;
      }) => void)
    | undefined;
  let currentLedger = 10;
  const rpc: ChannelWatchRpc = {
    watchChannel: vi.fn(async (input) => {
      event = input.onEvent;
      return vi.fn();
    }),
    getChannelState: vi.fn(async () => ({
      closeEffectiveAtLedger: null,
      refundWaitingPeriod: 20,
      currentLedger,
      balance: "100",
    })),
  };
  return {
    rpc,
    get event() {
      return event;
    },
    set ledger(value: number) {
      currentLedger = value;
    },
  };
}

describe("createChannelWatchtower", () => {
  it("settles the latest voucher on a future close", async () => {
    const h = harness();
    const disputes: unknown[] = [];
    const tower = createChannelWatchtower({
      registry: { list: async () => [channel] },
      settlement: {
        settle: vi.fn(async () => ({ txHash: "TX", settledAmount: "42" })),
      },
      rpc: h.rpc,
      network: "testnet",
      rpcUrl: "https://rpc.example",
      intervalMs: 1_000,
      safetyMarginLedgers: 1,
      cursorStore: { get: async () => 1, set: async () => undefined },
      onDispute: async (dispute) => {
        disputes.push(dispute);
      },
    });
    await tower.start();
    h.event?.({ type: "close_start", effectiveAtLedger: 30, currentLedger: 10 });
    await vi.waitFor(() => expect(disputes).toHaveLength(1));
    expect(disputes[0]).toMatchObject({ channelId: "CCHANNEL", settledAmount: "42", txHash: "TX" });
    await tower.stop();
  });

  it("reports a loss and submits nothing after the effective ledger", async () => {
    const h = harness();
    h.ledger = 40;
    const settle = vi.fn();
    const losses: unknown[] = [];
    const tower = createChannelWatchtower({
      registry: { list: async () => [channel] },
      settlement: { settle },
      rpc: h.rpc,
      network: "testnet",
      rpcUrl: "https://rpc.example",
      intervalMs: 1_000,
      safetyMarginLedgers: 1,
      cursorStore: { get: async () => undefined, set: async () => undefined },
      onLoss: async (loss) => {
        losses.push(loss);
      },
    });
    await tower.start();
    h.event?.({ type: "close_start", effectiveAtLedger: 30, currentLedger: 40 });
    await vi.waitFor(() => expect(losses).toHaveLength(1));
    expect(settle).not.toHaveBeenCalled();
    await tower.stop();
  });

  it("rejects a registration whose refund period cannot cover reaction time", async () => {
    const tower = createChannelWatchtower({
      registry: { list: async () => [{ ...channel, refundWaitingPeriod: 1 }] },
      settlement: { settle: async () => ({ txHash: "TX", settledAmount: "42" }) },
      rpc: harness().rpc,
      network: "testnet",
      rpcUrl: "https://rpc.example",
      intervalMs: 10_000,
      safetyMarginLedgers: 2,
      cursorStore: { get: async () => undefined, set: async () => undefined },
    });
    await expect(tower.start()).rejects.toThrow(/refundWaitingPeriod/);
  });
});
