import { close, getChannelState } from "@stellar/mpp/channel/server";
import { base64UrlToBytes, type StellarNetwork } from "@vegaforge/tollway-core";
import type { AcceptedVoucher, VoucherStore } from "./mpp-channel.js";

/**
 * On-chain channel settlement and service scheduler (#174).
 *
 * Submits the latest accepted cumulative voucher for a channel via
 * `@stellar/mpp/channel/server` `close()`, enforces a fee cap
 * (`maxFeeBumpStroops`), maintains fail-closed settling markers for
 * ambiguous broadcasts, and derives `SettlementRecord` (`{ channelId,
 * settledAmount, returnedRemainder, txHash }`) for reconciliation.
 */

const MPP_NETWORK: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const DEFAULT_MAX_FEE_BUMP_STROOPS = 100_000;
const HEX_SIGNATURE = /^[0-9a-fA-F]{128}$/;

/** Matches `@vegaforge/tollway-reconcile`'s `SettlementRecord`. */
export type ChannelSettlementRecord = {
  channelId: string;
  settledAmount: string;
  returnedRemainder: string;
  txHash: string;
};

export type SettlingMarker = {
  channelId: string;
  cumulativeAmount: string;
  startedAt: string;
  status: "settling" | "settled" | "unknown";
  txHash?: string;
  returnedRemainder?: string;
  errorMessage?: string;
};

/** Fail-closed store tracking in-flight, completed, and ambiguous channel closes. */
export interface ChannelSettlementStore {
  getMarker(channelId: string): Promise<SettlingMarker | undefined>;
  /**
   * Atomically claims the channel for settlement. Returns `false` if a
   * marker already exists (`settling`, `settled`, or `unknown`).
   */
  markSettling(channelId: string, cumulativeAmount: string): Promise<boolean>;
  markSettled(channelId: string, record: ChannelSettlementRecord): Promise<void>;
  /**
   * Marks a broadcast whose outcome is unknown (e.g. `PollTimeoutError`).
   * The marker stays in place until an operator reconciles against on-chain
   * state and calls `clearMarker`.
   */
  markUnknown(channelId: string, errorMessage: string): Promise<void>;
  clearMarker(channelId: string): Promise<void>;
  listMarkers(): Promise<readonly SettlingMarker[]>;
}

export function createInMemoryChannelSettlementStore(
  options: { now?: () => string } = {},
): ChannelSettlementStore {
  const now = options.now ?? (() => new Date().toISOString());
  const markers = new Map<string, SettlingMarker>();

  return {
    async getMarker(channelId) {
      return markers.get(channelId);
    },
    async markSettling(channelId, cumulativeAmount) {
      if (markers.has(channelId)) {
        return false;
      }
      markers.set(channelId, {
        channelId,
        cumulativeAmount,
        startedAt: now(),
        status: "settling",
      });
      return true;
    },
    async markSettled(channelId, record) {
      const existing = markers.get(channelId);
      markers.set(channelId, {
        channelId,
        cumulativeAmount: record.settledAmount,
        startedAt: existing?.startedAt ?? now(),
        status: "settled",
        txHash: record.txHash,
        returnedRemainder: record.returnedRemainder,
      });
    },
    async markUnknown(channelId, errorMessage) {
      const existing = markers.get(channelId);
      markers.set(channelId, {
        channelId,
        cumulativeAmount: existing?.cumulativeAmount ?? "0",
        startedAt: existing?.startedAt ?? now(),
        status: "unknown",
        errorMessage,
      });
    },
    async clearMarker(channelId) {
      markers.delete(channelId);
    },
    async listMarkers() {
      return [...markers.values()];
    },
  };
}

/** Decodes a 64-byte Ed25519 signature from 128-char hex or base64url. */
export function decodeCommitmentSignature(commitment: string): Uint8Array {
  if (HEX_SIGNATURE.test(commitment)) {
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) {
      out[i] = Number.parseInt(commitment.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  const bytes = base64UrlToBytes(commitment);
  if (bytes.length !== 64) {
    throw new RangeError(`commitment signature must decode to 64 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * `@stellar/mpp` does not export `PollTimeoutError` or `PollMaxAttemptsError`
 * from its package index, so we detect ambiguous polling failures by name/message.
 */
export function isAmbiguousCloseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "PollTimeoutError" || error.name === "PollMaxAttemptsError") {
    return true;
  }
  return /poll.*(timeout|max\s*attempts)/i.test(error.message);
}

export type ChannelSettler = {
  settle(input: {
    channelId: string;
    cumulativeAmount: string;
    commitment: string;
  }): Promise<ChannelSettlementRecord>;
};

type CloseSigner = Parameters<typeof close>[0]["feePayer"]["envelopeSigner"];

export type StellarChannelSettlerOptions = {
  network: StellarNetwork;
  rpcUrl: string;
  feePayer: {
    envelopeSigner: CloseSigner;
    feeBumpSigner?: CloseSigner;
  };
  /**
   * Hard cap on fee-bump stroops for standalone `close()` calls, since
   * `close()` bypasses `verify()`'s `feeBudget`. Defaults to 100 000 stroops.
   */
  maxFeeBumpStroops?: number;
  pollMaxAttempts?: number;
  pollDelayMs?: number;
  pollTimeoutMs?: number;
  settlementStore?: ChannelSettlementStore;
  /** Injectable `close` for deterministic tests. */
  closeChannel?: (input: {
    channel: string;
    amount: bigint;
    signature: Uint8Array;
    maxFeeBumpStroops: number;
  }) => Promise<string>;
  /** Injectable `getChannelState` for deterministic tests. */
  readChannelState?: (input: { channel: string }) => Promise<{ balance: string | bigint }>;
};

/**
 * Builds a {@link ChannelSettler} that closes channels on Stellar from a
 * voucher, enforces `maxFeeBumpStroops`, writes fail-closed markers, and
 * derives `returnedRemainder` from on-chain balance.
 */
export function createStellarChannelSettler(
  options: StellarChannelSettlerOptions,
): ChannelSettler {
  const maxFeeBumpStroops = options.maxFeeBumpStroops ?? DEFAULT_MAX_FEE_BUMP_STROOPS;
  if (!Number.isSafeInteger(maxFeeBumpStroops) || maxFeeBumpStroops <= 0) {
    throw new TypeError("maxFeeBumpStroops must be a positive integer");
  }
  const store = options.settlementStore ?? createInMemoryChannelSettlementStore();
  const network = MPP_NETWORK[options.network];

  const readState =
    options.readChannelState ??
    (async ({ channel }) => {
      const state = await getChannelState({
        channel,
        network,
        rpcUrl: options.rpcUrl,
      });
      return { balance: state.balance };
    });

  const submitClose =
    options.closeChannel ??
    (async ({ channel, amount, signature, maxFeeBumpStroops: feeCap }) => {
      return close({
        channel,
        amount,
        signature,
        feePayer: options.feePayer,
        network,
        rpcUrl: options.rpcUrl,
        maxFeeBumpStroops: feeCap,
        pollMaxAttempts: options.pollMaxAttempts,
        pollDelayMs: options.pollDelayMs,
        pollTimeoutMs: options.pollTimeoutMs,
      });
    });

  return {
    async settle({ channelId, cumulativeAmount, commitment }) {
      const claimed = await store.markSettling(channelId, cumulativeAmount);
      if (!claimed) {
        const existing = await store.getMarker(channelId);
        if (existing?.status === "settled" && existing.txHash && existing.returnedRemainder) {
          return {
            channelId,
            settledAmount: existing.cumulativeAmount,
            returnedRemainder: existing.returnedRemainder,
            txHash: existing.txHash,
          };
        }
        throw new Error(
          `channel ${channelId} has an active or unresolved settling marker (${existing?.status ?? "unknown"})`,
        );
      }

      try {
        const state = await readState({ channel: channelId });
        const balance = BigInt(state.balance);
        const amount = BigInt(cumulativeAmount);
        const signature = decodeCommitmentSignature(commitment);

        const txHash = await submitClose({
          channel: channelId,
          amount,
          signature,
          maxFeeBumpStroops,
        });

        const remainder = balance >= amount ? balance - amount : 0n;
        const record: ChannelSettlementRecord = {
          channelId,
          settledAmount: cumulativeAmount,
          returnedRemainder: remainder.toString(),
          txHash,
        };
        await store.markSettled(channelId, record);
        return record;
      } catch (error) {
        if (isAmbiguousCloseError(error)) {
          await store.markUnknown(
            channelId,
            error instanceof Error ? error.message : "close outcome unknown",
          );
        } else {
          await store.clearMarker(channelId);
        }
        throw error;
      }
    },
  };
}

export type ChannelSettlementRunReport = {
  settled: ChannelSettlementRecord[];
  skipped: string[];
  failed: Array<{ channelId: string; error: string }>;
  staleMarkers: SettlingMarker[];
};

export type ChannelSettlementSchedulerOptions = {
  voucherStore: VoucherStore;
  settler: ChannelSettler;
  settlementStore?: ChannelSettlementStore;
  intervalMs: number;
  /** Optional predicate to decide whether a channel's latest voucher is due for settlement. */
  shouldSettle?: (voucher: AcceptedVoucher, nowMs: number) => boolean;
  /** Settle vouchers older than this many milliseconds (when `shouldSettle` is omitted). */
  maxVoucherAgeMs?: number;
  /** Minimum cumulativeAmount required before settling (when `shouldSettle` is omitted). */
  minSettleAmount?: string;
  /** Age in ms after which a `settling` or `unknown` marker is reported as stale. Defaults to 300 000. */
  staleMarkerThresholdMs?: number;
  onSettled?: (record: ChannelSettlementRecord) => void | Promise<void>;
  onStaleMarker?: (marker: SettlingMarker) => void | Promise<void>;
  onError?: (error: unknown, channelId: string) => void | Promise<void>;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export type ChannelSettlementScheduler = {
  runOnce(): Promise<ChannelSettlementRunReport>;
  start(): void;
  stop(): Promise<void>;
};

const DEFAULT_STALE_MARKER_MS = 300_000;

/**
 * Periodically sweeps accepted channel vouchers and closes eligible channels
 * on chain via {@link ChannelSettler}.
 */
export function createChannelSettlementScheduler(
  options: ChannelSettlementSchedulerOptions,
): ChannelSettlementScheduler {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive integer");
  }
  const settlementStore = options.settlementStore ?? createInMemoryChannelSettlementStore();
  const staleThresholdMs = options.staleMarkerThresholdMs ?? DEFAULT_STALE_MARKER_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;

  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<ChannelSettlementRunReport> | undefined;

  function isDue(voucher: AcceptedVoucher, nowMs: number): boolean {
    if (options.shouldSettle) {
      return options.shouldSettle(voucher, nowMs);
    }
    if (options.minSettleAmount !== undefined && BigInt(voucher.cumulativeAmount) < BigInt(options.minSettleAmount)) {
      return false;
    }
    if (options.maxVoucherAgeMs !== undefined) {
      const acceptedAtMs = Date.parse(voucher.acceptedAt);
      if (Number.isFinite(acceptedAtMs) && nowMs - acceptedAtMs < options.maxVoucherAgeMs) {
        return false;
      }
    }
    return true;
  }

  async function sweep(): Promise<ChannelSettlementRunReport> {
    const nowMs = now();
    const report: ChannelSettlementRunReport = {
      settled: [],
      skipped: [],
      failed: [],
      staleMarkers: [],
    };

    const markers = await settlementStore.listMarkers();
    for (const marker of markers) {
      if (marker.status === "settling" || marker.status === "unknown") {
        const startedMs = Date.parse(marker.startedAt);
        if (marker.status === "unknown" || (Number.isFinite(startedMs) && nowMs - startedMs >= staleThresholdMs)) {
          report.staleMarkers.push(marker);
          await options.onStaleMarker?.(marker);
        }
      }
    }

    const latestVouchers = await options.voucherStore.listLatest();
    for (const voucher of latestVouchers) {
      const marker = await settlementStore.getMarker(voucher.channelId);
      if (marker) {
        report.skipped.push(voucher.channelId);
        continue;
      }
      if (!isDue(voucher, nowMs)) {
        report.skipped.push(voucher.channelId);
        continue;
      }
      try {
        const record = await options.settler.settle({
          channelId: voucher.channelId,
          cumulativeAmount: voucher.cumulativeAmount,
          commitment: voucher.commitment,
        });
        report.settled.push(record);
        await options.onSettled?.(record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ channelId: voucher.channelId, error: message });
        await options.onError?.(error, voucher.channelId);
      }
    }

    return report;
  }

  return {
    async runOnce() {
      if (running) return running;
      running = sweep().finally(() => {
        running = undefined;
      });
      return running;
    },
    start() {
      if (timer !== undefined) return;
      timer = setTimer(() => {
        void this.runOnce();
      }, options.intervalMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        timer.unref();
      }
    },
    async stop() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      if (running) {
        await running;
      }
    },
  };
}
