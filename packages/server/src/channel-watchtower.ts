import type { StellarNetwork } from "@vegaforge/tollway-core";
import { getChannelState, watchChannel } from "@stellar/mpp/channel/server";

export type WatchtowerChannel = {
  channelId: string;
  network: StellarNetwork;
  refundWaitingPeriod: number;
  /** The latest accepted cumulative voucher, if one exists. */
  voucher?: { cumulativeAmount: string; commitment: string };
};

export type ChannelState = {
  closeEffectiveAtLedger: number | null;
  refundWaitingPeriod: number;
  currentLedger: number;
  balance: string;
};

export type WatchtowerEvent = {
  type: "close_start" | "close";
  effectiveAtLedger: number;
  currentLedger: number;
};

export type ChannelWatchRegistry = {
  list(): Promise<readonly WatchtowerChannel[]>;
};

export type WatchtowerCursorStore = {
  get(): Promise<number | undefined>;
  set(ledger: number): Promise<void>;
};

export type ChannelWatchRpc = {
  watchChannel(input: {
    channel: string;
    network: StellarNetwork;
    rpcUrl: string;
    intervalMs: number;
    startLedger?: number;
    onEvent(event: WatchtowerEvent): void | Promise<void>;
    onError(error: unknown): void | Promise<void>;
    signal: AbortSignal;
  }): Promise<() => void> | (() => void);
  getChannelState(input: {
    channel: string;
    network: StellarNetwork;
    rpcUrl: string;
  }): Promise<ChannelState>;
};

export type ChannelWatchSettlement = {
  settle(input: {
    channelId: string;
    cumulativeAmount: string;
    commitment: string;
  }): Promise<{ txHash: string; settledAmount: string }>;
};

export type ChannelDispute = {
  channelId: string;
  effectiveAtLedger: number;
  currentLedger: number;
  settledAmount: string;
  txHash: string;
};

export type ChannelLoss = {
  channelId: string;
  effectiveAtLedger: number;
  currentLedger: number;
  amountAtRisk: string;
  reason: "already-effective" | "settlement-failed";
};

export type CreateChannelWatchtowerOptions = {
  registry: ChannelWatchRegistry;
  settlement: ChannelWatchSettlement;
  rpc: ChannelWatchRpc;
  network: StellarNetwork;
  rpcUrl: string;
  intervalMs: number;
  safetyMarginLedgers: number;
  cursorStore: WatchtowerCursorStore;
  onDispute?(dispute: ChannelDispute): void | Promise<void>;
  onLoss?(loss: ChannelLoss): void | Promise<void>;
  onError?(error: unknown, channelId?: string): void | Promise<void>;
  /** Injectable timer for deterministic tests. */
  setTimeout?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout?(handle: ReturnType<typeof setTimeout>): void;
};

export type ChannelWatchtower = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

const MPP_NETWORK: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

/** Adapter for the pinned `@stellar/mpp@0.7.1` watcher and state simulation APIs. */
export function createStellarChannelWatchRpc(simulationTimeoutMs?: number): ChannelWatchRpc {
  return {
    watchChannel(input) {
      return watchChannel({
        channel: input.channel,
        network: MPP_NETWORK[input.network],
        rpcUrl: input.rpcUrl,
        intervalMs: input.intervalMs,
        startLedger: input.startLedger,
        signal: input.signal,
        onEvent(event) {
          if (event.type !== "close") return;
          void input.onEvent({
            type: event.effectiveAtLedger > event.ledger ? "close_start" : "close",
            effectiveAtLedger: event.effectiveAtLedger,
            currentLedger: event.ledger,
          });
        },
        onError: input.onError,
      });
    },
    async getChannelState(input) {
      const state = await getChannelState({
        channel: input.channel,
        network: MPP_NETWORK[input.network],
        rpcUrl: input.rpcUrl,
        simulationTimeoutMs,
      });
      return {
        closeEffectiveAtLedger: state.closeEffectiveAtLedger,
        refundWaitingPeriod: state.refundWaitingPeriod,
        currentLedger: state.currentLedger,
        balance: state.balance.toString(),
      };
    },
  };
}

const DEFAULT_BACKOFF_MS = 250;

export function createChannelWatchtower(
  options: CreateChannelWatchtowerOptions,
): ChannelWatchtower {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive integer");
  }
  if (!Number.isSafeInteger(options.safetyMarginLedgers) || options.safetyMarginLedgers < 0) {
    throw new TypeError("safetyMarginLedgers must be a non-negative integer");
  }

  const controller = new AbortController();
  const stopTimers = new Set<ReturnType<typeof setTimeout>>();
  const stops = new Map<string, () => void>();
  const inFlight = new Set<Promise<void>>();
  let started = false;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  async function reportError(error: unknown, channelId?: string): Promise<void> {
    await options.onError?.(error, channelId);
  }

  async function settleBeforeClose(
    channel: WatchtowerChannel,
    event: WatchtowerEvent,
  ): Promise<void> {
    const state = await options.rpc.getChannelState({
      channel: channel.channelId,
      network: channel.network,
      rpcUrl: options.rpcUrl,
    });
    const effectiveAtLedger = event.effectiveAtLedger;
    const currentLedger = Math.max(event.currentLedger, state.currentLedger);
    const voucher = channel.voucher;
    if (effectiveAtLedger <= currentLedger) {
      await options.onLoss?.({
        channelId: channel.channelId,
        effectiveAtLedger,
        currentLedger,
        amountAtRisk: state.balance,
        reason: "already-effective",
      });
      return;
    }
    if (!voucher) return;

    const deadline = effectiveAtLedger - options.safetyMarginLedgers;
    let delay = DEFAULT_BACKOFF_MS;
    let lastError: unknown;
    while (!controller.signal.aborted) {
      const latest = await options.rpc.getChannelState({
        channel: channel.channelId,
        network: channel.network,
        rpcUrl: options.rpcUrl,
      });
      if (latest.currentLedger >= deadline) break;
      try {
        const settled = await options.settlement.settle({
          channelId: channel.channelId,
          cumulativeAmount: voucher.cumulativeAmount,
          commitment: voucher.commitment,
        });
        await options.onDispute?.({
          channelId: channel.channelId,
          effectiveAtLedger,
          currentLedger: latest.currentLedger,
          settledAmount: settled.settledAmount,
          txHash: settled.txHash,
        });
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => {
        let handle: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          controller.signal.removeEventListener("abort", finish);
          if (handle !== undefined) {
            stopTimers.delete(handle);
            clearTimer(handle);
          }
          resolve();
        };
        handle = setTimer(() => {
          if (handle !== undefined) stopTimers.delete(handle);
          controller.signal.removeEventListener("abort", finish);
          resolve();
        }, delay);
        stopTimers.add(handle);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
      delay = Math.min(delay * 2, options.intervalMs);
    }

    if (!controller.signal.aborted) {
      await options.onLoss?.({
        channelId: channel.channelId,
        effectiveAtLedger,
        currentLedger: (
          await options.rpc.getChannelState({
            channel: channel.channelId,
            network: channel.network,
            rpcUrl: options.rpcUrl,
          })
        ).currentLedger,
        amountAtRisk: state.balance,
        reason: "settlement-failed",
      });
      if (lastError !== undefined) await reportError(lastError, channel.channelId);
    }
  }

  async function handleEvent(channel: WatchtowerChannel, event: WatchtowerEvent): Promise<void> {
    await options.cursorStore.set(event.currentLedger);
    if (event.type === "close_start") {
      const task = settleBeforeClose(channel, event);
      inFlight.add(task);
      try {
        await task;
      } finally {
        inFlight.delete(task);
      }
      return;
    }
    stops.get(channel.channelId)?.();
    stops.delete(channel.channelId);
  }

  async function sweep(channels: readonly WatchtowerChannel[]): Promise<void> {
    for (const channel of channels) {
      try {
        const state = await options.rpc.getChannelState({
          channel: channel.channelId,
          network: channel.network,
          rpcUrl: options.rpcUrl,
        });
        if (state.closeEffectiveAtLedger !== null) {
          await handleEvent(channel, {
            type: "close_start",
            effectiveAtLedger: state.closeEffectiveAtLedger,
            currentLedger: state.currentLedger,
          });
        }
      } catch (error) {
        await reportError(error, channel.channelId);
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      const startLedger = await options.cursorStore.get();
      const channels = await options.registry.list();
      let smallestRefundPeriod = Number.MAX_SAFE_INTEGER;
      for (const channel of channels) {
        smallestRefundPeriod = Math.min(smallestRefundPeriod, channel.refundWaitingPeriod);
        if (
          channel.refundWaitingPeriod <
          Math.ceil(options.intervalMs / 5000) + options.safetyMarginLedgers
        ) {
          throw new TypeError(
            `channel ${channel.channelId} refundWaitingPeriod is too short for the watcher interval and safety margin`,
          );
        }
        const stop = await options.rpc.watchChannel({
          channel: channel.channelId,
          network: channel.network,
          rpcUrl: options.rpcUrl,
          intervalMs: options.intervalMs,
          startLedger,
          signal: controller.signal,
          onEvent: (event) => handleEvent(channel, event),
          onError: (error) => reportError(error, channel.channelId),
        });
        stops.set(channel.channelId, stop);
      }
      if (channels.length > 0) {
        const sweepMs = Math.max(
          options.intervalMs,
          (smallestRefundPeriod - options.safetyMarginLedgers) * 5_000,
        );
        sweepTimer = setInterval(() => {
          void sweep(channels);
        }, sweepMs);
        if (typeof sweepTimer === "object" && sweepTimer !== null && "unref" in sweepTimer) {
          sweepTimer.unref();
        }
      }
    },
    async stop(): Promise<void> {
      controller.abort();
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      for (const stop of stops.values()) stop();
      for (const handle of stopTimers) clearTimer(handle);
      await Promise.all(inFlight);
      stops.clear();
      stopTimers.clear();
    },
  };
}
