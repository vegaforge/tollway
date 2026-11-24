/**
 * Live reconciliation of open MPP payment channels against on-chain contract
 * state (#212).
 *
 * Reads the channel contract state via `@stellar/mpp/channel/server`
 * (`getChannelState`) and compares it against Tollway's channel record and
 * commitment stream, flagging unexpected closes, wrong recipient/funder/token,
 * and balance drift before the channel closes.
 */

import { getChannelState, watchChannel } from "@stellar/mpp/channel/server";
import type { StellarNetwork } from "@vegaforge/tollway-core";
import { resolveAssetContractId } from "./charge.js";
import type { CommitmentRecord, Drift, DriftKind } from "./index.js";

export type OpenChannelDriftKind =
  | "unexpected-close"
  | "recipient-mismatch"
  | "token-mismatch"
  | "balance-mismatch";

export type MppNetworkId = "stellar:testnet" | "stellar:pubnet";

export const MPP_NETWORK_ID: Record<StellarNetwork, MppNetworkId> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

/** Subset of Tollway's `Channel` record needed for live reconciliation. */
export type OpenChannelRecord = {
  id: string;
  counterparty: string;
  asset: string;
  deposit: string;
  committed: string;
  status: string;
  network: StellarNetwork;
};

/** Shape returned by `@stellar/mpp/channel/server`'s `getChannelState`. */
export type OnChainChannelState = {
  balance: bigint;
  refundWaitingPeriod: number;
  token: string;
  from: string;
  to: string;
  closeEffectiveAtLedger: number | null | undefined;
  currentLedger: number;
};

export type ChannelStateReader = (params: {
  channel: string;
  network?: MppNetworkId;
  rpcUrl?: string;
  simulationTimeoutMs?: number;
}) => Promise<OnChainChannelState>;

export type ReconcileOpenChannelOptions = {
  /**
   * Expected funder address (`G...` or `C...`). The channel record does not
   * store the funder, so supply it here to verify `state.from`.
   */
  funder?: string;
  /** Observed cumulative withdrawals on chain, as an integer string. Defaults to `"0"`. */
  observedWithdrawn?: string;
  /** Soroban RPC URL passed to `getChannelState`. */
  rpcUrl?: string;
  /** Simulation timeout in milliseconds passed to `getChannelState`. */
  simulationTimeoutMs?: number;
  /** Override `getChannelState` for tests or custom RPC adapters. */
  readChannelState?: ChannelStateReader;
};

const AMOUNT_RE = /^[0-9]+$/;

function parseNonNegInt(
  value: string,
  field: string,
): { ok: true; amount: bigint } | { ok: false; drift: Drift } {
  if (!AMOUNT_RE.test(value)) {
    return {
      ok: false,
      drift: {
        kind: "malformed-record",
        detail: `${field} "${value}" is not a valid non-negative integer string`,
      },
    };
  }
  return { ok: true, amount: BigInt(value) };
}

/**
 * Compares an open channel's local record and commitment stream against its
 * current on-chain contract state. Returns all detected drift items.
 */
export async function checkOpenChannelDrift(
  channel: OpenChannelRecord,
  commitments: CommitmentRecord[],
  options: ReconcileOpenChannelOptions = {},
): Promise<Drift[]> {
  const drifts: Drift[] = [];

  const depositRes = parseNonNegInt(channel.deposit, "channel.deposit");
  if (!depositRes.ok) {
    drifts.push(depositRes.drift);
    return drifts;
  }
  const deposit = depositRes.amount;

  const committedRes = parseNonNegInt(channel.committed, "channel.committed");
  if (!committedRes.ok) {
    drifts.push(committedRes.drift);
    return drifts;
  }
  const committed = committedRes.amount;

  const withdrawnStr = options.observedWithdrawn ?? "0";
  const withdrawnRes = parseNonNegInt(withdrawnStr, "observedWithdrawn");
  if (!withdrawnRes.ok) {
    drifts.push(withdrawnRes.drift);
    return drifts;
  }
  const withdrawn = withdrawnRes.amount;

  // Validate commitment stream integrity for this channel.
  const own: CommitmentRecord[] = [];
  for (const commitment of commitments) {
    if (commitment.channelId === channel.id) {
      own.push(commitment);
    } else {
      drifts.push({
        kind: "foreign-commitment",
        detail: `commitment at sequence ${commitment.sequence} belongs to channel ${commitment.channelId}, not ${channel.id}; excluded from checks`,
      });
    }
  }

  const bySequence = new Map<number, { amount: bigint; count: number }>();
  for (const entry of own) {
    const parsed = parseNonNegInt(
      entry.cumulativeAmount,
      `commitments[${entry.sequence}].cumulativeAmount`,
    );
    if (!parsed.ok) {
      drifts.push(parsed.drift);
      return drifts;
    }
    const seen = bySequence.get(entry.sequence);
    bySequence.set(entry.sequence, {
      amount: seen && seen.amount > parsed.amount ? seen.amount : parsed.amount,
      count: (seen?.count ?? 0) + 1,
    });
  }

  const sequences = [...bySequence.keys()].sort((a, b) => a - b);
  for (const sequence of sequences) {
    const seen = bySequence.get(sequence);
    if (seen && seen.count > 1) {
      drifts.push({
        kind: "duplicate-sequence",
        detail: `sequence ${sequence} appears ${seen.count} times; highest amount ${seen.amount} is used`,
      });
    }
  }

  for (const [i, sequence] of sequences.entries()) {
    if (sequence !== i) {
      drifts.push({
        kind: "sequence-gap",
        detail: `sequence gap at position ${i}: expected sequence ${i}, got ${sequence}`,
      });
      break;
    }
  }

  let previous: { sequence: number; amount: bigint } | undefined;
  let highest = 0n;
  let reportedDecrease = false;
  for (const sequence of sequences) {
    const amount = bySequence.get(sequence)?.amount ?? 0n;
    if (previous && amount < previous.amount && !reportedDecrease) {
      drifts.push({
        kind: "non-monotonic-cumulative",
        detail: `cumulative amount fell from ${previous.amount} at sequence ${previous.sequence} to ${amount} at sequence ${sequence}`,
      });
      reportedDecrease = true;
    }
    if (amount > highest) highest = amount;
    previous = { sequence, amount };
  }

  if (committed > deposit || highest > deposit) {
    drifts.push({
      kind: "balance-mismatch",
      detail: `committed amount (${committed > highest ? committed : highest}) exceeds channel deposit (${deposit})`,
    });
  }

  const readState: ChannelStateReader = options.readChannelState ?? getChannelState;
  const state = await readState({
    channel: channel.id,
    network: MPP_NETWORK_ID[channel.network],
    ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.simulationTimeoutMs !== undefined
      ? { simulationTimeoutMs: options.simulationTimeoutMs }
      : {}),
  });

  if (channel.status === "open" && state.closeEffectiveAtLedger != null) {
    drifts.push({
      kind: "unexpected-close",
      detail: `channel ${channel.id} is marked open locally, but close is effective at ledger ${state.closeEffectiveAtLedger} (currentLedger=${state.currentLedger})`,
    });
  }

  if (state.to !== channel.counterparty) {
    drifts.push({
      kind: "recipient-mismatch",
      detail: `on-chain recipient ${state.to} does not match channel counterparty ${channel.counterparty}`,
    });
  }

  if (options.funder !== undefined && state.from !== options.funder) {
    drifts.push({
      kind: "recipient-mismatch",
      detail: `on-chain funder ${state.from} does not match expected funder ${options.funder}`,
    });
  }

  let expectedToken: string | undefined;
  try {
    expectedToken = resolveAssetContractId(channel.asset, channel.network);
  } catch (error) {
    drifts.push({
      kind: "token-mismatch",
      detail: `cannot resolve channel asset "${channel.asset}": ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (expectedToken !== undefined && state.token !== expectedToken) {
    drifts.push({
      kind: "token-mismatch",
      detail: `on-chain token ${state.token} does not match expected asset contract ${expectedToken}`,
    });
  }

  const expectedBalance = deposit - withdrawn;
  if (state.balance !== expectedBalance) {
    drifts.push({
      kind: "balance-mismatch",
      detail: `on-chain balance is ${state.balance}, expected ${expectedBalance} (deposit ${deposit} - withdrawn ${withdrawn})`,
    });
  }

  return drifts;
}

export type ChannelWatchEvent = {
  type: "open" | "close" | "withdraw" | "refund";
  amount?: bigint;
  effectiveAtLedger?: number;
  ledger?: number;
};

export type WatchOpenChannelOptions = ReconcileOpenChannelOptions & {
  channel: OpenChannelRecord;
  getCommitments: () => Promise<CommitmentRecord[]> | CommitmentRecord[];
  onDrift: (drifts: Drift[], event: ChannelWatchEvent) => void | Promise<void>;
  onError?: (error: Error) => void;
  intervalMs?: number;
  startLedger?: number;
  signal?: AbortSignal;
  watch?: typeof watchChannel;
};

/**
 * Watches an open channel's on-chain events via `@stellar/mpp/channel/server`'s
 * `watchChannel`, tracks cumulative withdrawals, and runs live drift checks
 * whenever an event lands.
 */
export function startOpenChannelWatcher(options: WatchOpenChannelOptions): () => void {
  const { channel, getCommitments, onDrift, onError } = options;
  let observedWithdrawn = BigInt(options.observedWithdrawn ?? "0");
  const runWatch = options.watch ?? watchChannel;

  return runWatch({
    channel: channel.id,
    network: MPP_NETWORK_ID[channel.network],
    ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.startLedger !== undefined ? { startLedger: options.startLedger } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onEvent: async (rawEvent) => {
      const event = rawEvent as unknown as ChannelWatchEvent;
      if (event.type === "withdraw" && typeof event.amount === "bigint") {
        observedWithdrawn += event.amount;
      }
      try {
        const commitments = await getCommitments();
        const drifts = await checkOpenChannelDrift(channel, commitments, {
          ...options,
          observedWithdrawn: observedWithdrawn.toString(),
        });
        if (drifts.length > 0) {
          await onDrift(drifts, event);
        }
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
    ...(onError ? { onError } : {}),
  });
}

export type AllOpenChannelDriftKinds = Extract<DriftKind, OpenChannelDriftKind>;
