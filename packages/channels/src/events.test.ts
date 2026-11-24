import { describe, expect, it, vi } from "vitest";
import type { CloseAdapterInput, CloseAdapterResult, MppChannelAdapter } from "./adapter.js";
import { CloseNotSubmittedError, SettlementMismatchError } from "./errors.js";
import { type ChannelLifecycleEvent, toObservabilitySink } from "./events.js";
import { createChannelManager } from "./manager.js";
import { createMemoryCommitmentStore } from "./store.js";

const NOW = "2026-11-24T10:00:00.000Z";
const OPEN = {
  counterparty: "GSERVICE",
  asset: "CUSDC",
  deposit: "1000",
  network: "testnet" as const,
};

function fakeAdapter(
  close?: (input: CloseAdapterInput) => CloseAdapterResult | Promise<CloseAdapterResult>,
): MppChannelAdapter {
  return {
    async openChannel() {
      return { channelId: "CCHAN1", openTxHash: "tx-open" };
    },
    async getChannelState() {
      return { balance: "1000", currentLedger: 100 };
    },
    async findChannelSettlement() {
      return null;
    },
    async signCommitment(input) {
      return { commitment: `sig:${input.cumulativeAmount}` };
    },
    async closeChannel(input) {
      if (close) return close(input);
      return {
        settlementTxHash: "tx-close",
        settledAmount: input.cumulativeAmount,
        returnedRemainder: (BigInt(input.deposit) - BigInt(input.cumulativeAmount)).toString(),
      };
    },
  };
}

function recorder() {
  const events: ChannelLifecycleEvent[] = [];
  return { events, onEvent: (event: ChannelLifecycleEvent) => void events.push(event) };
}

describe("channel lifecycle events (#187)", () => {
  it("emits opened, closing and closed in order with timestamps and integer-string amounts", async () => {
    const { events, onEvent } = recorder();
    const manager = createChannelManager({ adapter: fakeAdapter(), onEvent, now: () => NOW });

    const channel = await manager.open(OPEN);
    await manager.commit(channel.id, "250");
    await manager.close(channel.id);

    expect(events.map((event) => event.type)).toEqual([
      "channel:opened",
      "channel:closing",
      "channel:closed",
    ]);
    expect(events[0]).toEqual({
      type: "channel:opened",
      at: NOW,
      channelId: "CCHAN1",
      counterparty: "GSERVICE",
      asset: "CUSDC",
      network: "testnet",
      deposit: "1000",
      openTxHash: "tx-open",
    });
    expect(events[1]).toMatchObject({ type: "channel:closing", cumulativeAmount: "250" });
    expect(events[2]).toEqual({
      type: "channel:closed",
      at: NOW,
      channelId: "CCHAN1",
      counterparty: "GSERVICE",
      asset: "CUSDC",
      network: "testnet",
      settlementTxHash: "tx-close",
      settledAmount: "250",
      returnedRemainder: "750",
    });
  });

  it("reports a close that submitted nothing as close-failed with the channel back to open", async () => {
    const { events, onEvent } = recorder();
    const manager = createChannelManager({
      adapter: fakeAdapter((input) => {
        throw new CloseNotSubmittedError(input.channelId, new Error("rpc down"));
      }),
      onEvent,
    });
    const channel = await manager.open(OPEN);

    await expect(manager.close(channel.id)).rejects.toBeInstanceOf(CloseNotSubmittedError);

    expect(events.map((event) => event.type)).toEqual([
      "channel:opened",
      "channel:closing",
      "channel:close-failed",
    ]);
    expect(events[2]).toMatchObject({ status: "open" });
    expect((await manager.get(channel.id))?.status).toBe("open");
  });

  it("reports a close with an unknown outcome as close-failed with the channel left closing", async () => {
    const { events, onEvent } = recorder();
    const manager = createChannelManager({
      adapter: fakeAdapter(() => {
        throw new Error("connection reset after submit");
      }),
      onEvent,
    });
    const channel = await manager.open(OPEN);

    await expect(manager.close(channel.id)).rejects.toThrow("connection reset");

    expect(events.at(-1)).toMatchObject({ type: "channel:close-failed", status: "closing" });
    expect((await manager.get(channel.id))?.status).toBe("closing");
  });

  it("reports a settlement mismatch as close-failed, never as closed", async () => {
    const { events, onEvent } = recorder();
    const manager = createChannelManager({
      adapter: fakeAdapter(() => ({
        settlementTxHash: "tx-close",
        settledAmount: "999",
        returnedRemainder: "1",
      })),
      onEvent,
    });
    const channel = await manager.open(OPEN);
    await manager.commit(channel.id, "250");

    await expect(manager.close(channel.id)).rejects.toBeInstanceOf(SettlementMismatchError);

    expect(events.map((event) => event.type)).not.toContain("channel:closed");
    expect(events.at(-1)).toMatchObject({
      type: "channel:close-failed",
      status: "settlement-mismatched",
    });
  });

  it("emits nothing when the store write fails", async () => {
    const { events, onEvent } = recorder();
    const store = createMemoryCommitmentStore();
    vi.spyOn(store, "putChannel").mockRejectedValue(new Error("disk full"));
    const manager = createChannelManager({ adapter: fakeAdapter(), store, onEvent });

    await expect(manager.open(OPEN)).rejects.toThrow("disk full");
    expect(events).toEqual([]);
  });

  it("keeps the result of open and close when the handler throws, and reports the error", async () => {
    const onEventError = vi.fn();
    const manager = createChannelManager({
      adapter: fakeAdapter(),
      onEvent: () => {
        throw new Error("observer broke");
      },
      onEventError,
    });

    const channel = await manager.open(OPEN);
    const closed = await manager.close(channel.id);

    expect(closed.settlementTxHash).toBe("tx-close");
    expect(onEventError).toHaveBeenCalledTimes(3);
    expect(onEventError.mock.calls[0]?.[0]).toEqual(new Error("observer broke"));
    expect(onEventError.mock.calls[0]?.[1]).toMatchObject({ type: "channel:opened" });
  });

  it("reports a rejecting handler without waiting for it or rejecting open", async () => {
    let reported: ((value: unknown) => void) | undefined;
    const errorReported = new Promise((resolve) => {
      reported = resolve;
    });
    const manager = createChannelManager({
      adapter: fakeAdapter(),
      onEvent: () => Promise.reject(new Error("webhook down")),
      onEventError: (error) => reported?.(error),
    });

    await expect(manager.open(OPEN)).resolves.toMatchObject({ id: "CCHAN1" });
    await expect(errorReported).resolves.toEqual(new Error("webhook down"));
  });
});

describe("toObservabilitySink (#187)", () => {
  it("maps opened and closed to the channel.opened and channel.closed webhooks", async () => {
    const emitted: unknown[] = [];
    const bridge = toObservabilitySink({
      emit: async (event) => {
        emitted.push(event);
      },
    });
    const manager = createChannelManager({
      adapter: fakeAdapter(),
      onEvent: bridge.onEvent,
      now: () => NOW,
    });

    const channel = await manager.open(OPEN);
    await manager.commit(channel.id, "250");
    await manager.close(channel.id);
    await bridge.flush();

    expect(emitted).toEqual([
      {
        type: "channel.opened",
        at: NOW,
        data: {
          channelId: "CCHAN1",
          counterparty: "GSERVICE",
          asset: "CUSDC",
          network: "testnet",
          deposit: "1000",
          openTxHash: "tx-open",
        },
      },
      {
        type: "channel.closed",
        at: NOW,
        data: {
          channelId: "CCHAN1",
          counterparty: "GSERVICE",
          asset: "CUSDC",
          network: "testnet",
          settlementTxHash: "tx-close",
          settledAmount: "250",
          returnedRemainder: "750",
        },
      },
    ]);
  });

  it("does not delay open on delivery, and flush waits for it", async () => {
    let deliver: () => void = () => {};
    const delivered = vi.fn();
    const bridge = toObservabilitySink({
      emit: () =>
        new Promise<void>((resolve) => {
          deliver = () => {
            delivered();
            resolve();
          };
        }),
    });
    const manager = createChannelManager({ adapter: fakeAdapter(), onEvent: bridge.onEvent });

    await manager.open(OPEN);
    expect(delivered).not.toHaveBeenCalled();

    let flushed = false;
    const flushing = bridge.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    deliver();
    await flushing;
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("reports a failed delivery instead of throwing or leaving it unhandled", async () => {
    const onDeliveryError = vi.fn();
    const bridge = toObservabilitySink(
      { emit: () => Promise.reject(new Error("hub down")) },
      { onDeliveryError },
    );
    const manager = createChannelManager({ adapter: fakeAdapter(), onEvent: bridge.onEvent });

    await manager.open(OPEN);
    await bridge.flush();

    expect(onDeliveryError).toHaveBeenCalledTimes(1);
    expect(onDeliveryError.mock.calls[0]?.[0]).toEqual(new Error("hub down"));
    expect(onDeliveryError.mock.calls[0]?.[1]).toMatchObject({ type: "channel:opened" });
  });

  it("does not forward closing and close-failed, which are not webhooks", async () => {
    const emit = vi.fn(async () => undefined);
    const bridge = toObservabilitySink({ emit });
    const manager = createChannelManager({
      adapter: fakeAdapter((input) => {
        throw new CloseNotSubmittedError(input.channelId, new Error("rpc down"));
      }),
      onEvent: bridge.onEvent,
    });

    const channel = await manager.open(OPEN);
    await expect(manager.close(channel.id)).rejects.toBeInstanceOf(CloseNotSubmittedError);
    await bridge.flush();

    expect(emit).toHaveBeenCalledTimes(1);
  });
});
