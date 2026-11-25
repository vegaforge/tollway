/**
 * Typed data layer for the channel detail page (`/channels/[channelId]`).
 *
 * The page reads one channel record, its whole commitment stream, the latest
 * reconciliation result and the receipts that settle through the channel. It
 * depends on `fetchChannelDetail` only. The service that serves
 * `ChannelManager.get` and `list` over HTTP (#227) replaces the body of that
 * function and nothing downstream changes.
 *
 * The reconciliation types mirror `ReconciliationResult` and `DriftKind` from
 * @vegaforge/tollway-reconcile. The dashboard does not depend on that package,
 * and adding the dependency changes `apps/dashboard/package.json`, which needs
 * maintainer review. Keep this list in step with the reconcile package.
 *
 * See docs/design.md, "The channel lifecycle manager".
 */

import type { Channel, Commitment } from "@vegaforge/tollway-channels";
import { fetchReceipts, type ReceiptRow } from "./receipts";

/** Every drift kind `@vegaforge/tollway-reconcile` reports. */
export const DRIFT_KINDS = [
  "under-settled",
  "over-settled",
  "missing-commitment",
  "unexpected-remainder",
  "sequence-gap",
  "malformed-record",
  "non-monotonic-cumulative",
  "foreign-commitment",
  "duplicate-sequence",
  // Live checks of an open channel against its contract state (#212).
  "closed-on-chain",
  "recipient-mismatch",
  "funder-mismatch",
  "token-mismatch",
  "balance-mismatch",
  // On-chain confirmation of x402 and MPP charge receipts (#211).
  "tx-failed",
  "tx-not-found",
  "transfer-missing",
  "amount-mismatch",
  "payee-mismatch",
  "payer-mismatch",
  "asset-mismatch",
  "network-mismatch",
] as const;

export type DriftKind = (typeof DRIFT_KINDS)[number];

export type Drift = { kind: DriftKind; detail: string };

/**
 * What the latest reconciliation of a channel found. A channel that has never
 * been reconciled is its own state: it must never read as "ok".
 */
export type ChannelReconciliation =
  | { status: "never-reconciled" }
  | { status: "ok"; checkedAt: string }
  | { status: "drift"; checkedAt: string; drift: Drift[] };

export type ChannelDetail = {
  channel: Channel;
  /** The whole commitment stream, ordered by sequence. */
  commitments: readonly Commitment[];
  reconciliation: ChannelReconciliation;
  /** Receipts that settle through this channel, newest first. */
  receipts: ReceiptRow[];
};

/** The close threshold the page marks on the chart, in basis points of the deposit. */
export const CLOSE_THRESHOLD_BASIS_POINTS = 8_000n;

/**
 * Loads one channel's detail. Resolves `null` for an id the source does not
 * track, so the page can show a not-found state instead of an error.
 */
export async function fetchChannelDetail(channelId: string): Promise<ChannelDetail | null> {
  const stub = STUB_CHANNELS.find((entry) => entry.channel.id === channelId);
  if (!stub) return null;

  const commitments = buildStream(stub);
  const receipts = (await fetchReceipts({ limit: 100 })).page.rows
    .filter(
      (row) =>
        row.receipt.settlement.kind === "channel-commitment" &&
        row.receipt.settlement.channelId === channelId,
    )
    .sort((a, b) => b.receipt.issuedAt.localeCompare(a.receipt.issuedAt));

  return {
    channel: stub.channel,
    commitments,
    reconciliation: stub.reconciliation,
    receipts,
  };
}

/** One commitment's step from the one before it. */
export type StepIssue = "sequence-gap" | "non-monotonic";

export type CommitmentStep = {
  sequence: number;
  cumulativeAmount: string;
  /** Change from the previous commitment, as a signed integer string. */
  deltaAmount: string;
  /** Empty for a step that follows its predecessor in order. */
  issues: StepIssue[];
};

/**
 * Pairs each commitment with its change from the one before. The first step
 * is measured from zero. A step is flagged when its sequence does not follow
 * the previous one, or when its cumulative amount falls. Amounts are compared
 * and subtracted as `bigint`.
 */
export function commitmentSteps(commitments: readonly Commitment[]): CommitmentStep[] {
  let previousSequence = -1;
  let previousCumulative = 0n;
  return commitments.map((commitment) => {
    const cumulative = BigInt(commitment.cumulativeAmount);
    const issues: StepIssue[] = [];
    if (commitment.sequence !== previousSequence + 1) issues.push("sequence-gap");
    if (cumulative < previousCumulative) issues.push("non-monotonic");
    const step: CommitmentStep = {
      sequence: commitment.sequence,
      cumulativeAmount: commitment.cumulativeAmount,
      deltaAmount: (cumulative - previousCumulative).toString(),
      issues,
    };
    previousSequence = commitment.sequence;
    previousCumulative = cumulative;
    return step;
  });
}

/**
 * Where `amount` sits on a chart whose top is `top`, in basis points (10,000
 * is the top). The division happens in `bigint`, so amounts above
 * `Number.MAX_SAFE_INTEGER` keep their place. Only the small ratio becomes a
 * number. A non-positive top scales to zero rather than dividing by it.
 */
export function scaleBasisPoints(amount: bigint, top: bigint): number {
  if (top <= 0n) return 0;
  return Number((amount * 10_000n) / top);
}

/** Committed over deposit in basis points, or null for a zero deposit. */
export function drawdownBasisPoints(committed: string, deposit: string): bigint | null {
  const total = BigInt(deposit);
  if (total === 0n) return null;
  return (BigInt(committed) * 10_000n) / total;
}

// ── stub data ─────────────────────────────────────────────────────────────────
//
// Deterministic. The four channels in the open-channels table keep the same
// deposit, committed amount and sequence, so the table and this page agree.
// Two more channels cover a long stream and a drifted, closed channel.

type StubEntry = {
  channel: Channel;
  streamLength: number;
  seed: number;
  /** A sequence to leave out of the stream, so the stub shows a gap. */
  missingSequence?: number;
  reconciliation: ChannelReconciliation;
};

const CHECKED_AT = "2026-11-22T10:00:00.000Z";

const STUB_CHANNELS: StubEntry[] = [
  {
    channel: {
      id: "ch-stripe-01",
      counterparty: "GCSTRIPE...XYZ",
      asset: "USDC",
      deposit: "5000000000",
      committed: "1250000000",
      sequence: 42,
      status: "open",
      network: "testnet",
      openTxHash: "open-tx-stripe-01",
      openedAt: "2026-11-18T08:00:00.000Z",
      lastCommitAt: "2026-11-23T16:40:00.000Z",
    },
    streamLength: 43,
    seed: 3,
    reconciliation: { status: "never-reconciled" },
  },
  {
    channel: {
      id: "ch-anthropic-02",
      counterparty: "GANTHROPIC...ABC",
      asset: "USDC",
      deposit: "10000000000",
      committed: "8600000000",
      sequence: 187,
      status: "open",
      network: "testnet",
      openTxHash: "open-tx-anthropic-02",
      openedAt: "2026-11-15T09:30:00.000Z",
      lastCommitAt: "2026-11-24T07:15:00.000Z",
    },
    streamLength: 188,
    seed: 5,
    reconciliation: { status: "never-reconciled" },
  },
  {
    channel: {
      id: "ch-openai-03",
      counterparty: "GOPENAI...QRS",
      asset: "USDC",
      deposit: "2000000000",
      committed: "1980000000",
      sequence: 96,
      status: "closing",
      network: "testnet",
      openTxHash: "open-tx-openai-03",
      openedAt: "2026-11-17T12:00:00.000Z",
      lastCommitAt: "2026-11-23T21:05:00.000Z",
      closeAttempt: {
        attemptId: "attempt-openai-03",
        startedAtLedger: 1_204_112,
        startedAt: "2026-11-23T21:10:00.000Z",
      },
    },
    streamLength: 97,
    seed: 7,
    reconciliation: { status: "never-reconciled" },
  },
  {
    channel: {
      id: "ch-perplexity-04",
      counterparty: "GPERPLEX...JKL",
      asset: "USDC",
      deposit: "1000000000",
      committed: "0",
      sequence: -1,
      status: "recovering",
      network: "testnet",
      openTxHash: "open-tx-perplexity-04",
      openedAt: "2026-11-10T14:00:00.000Z",
    },
    streamLength: 0,
    seed: 11,
    reconciliation: { status: "never-reconciled" },
  },
  {
    channel: {
      id: "ch-long-stream-05",
      counterparty: "GLONGSTREAM...MNO",
      asset: "USDC",
      deposit: "100000000000",
      committed: "61234567890",
      sequence: 299,
      status: "closed",
      network: "testnet",
      openTxHash: "open-tx-long-05",
      openedAt: "2026-11-01T06:00:00.000Z",
      lastCommitAt: "2026-11-20T18:30:00.000Z",
      settlementTxHash: "settle-tx-long-05",
      returnedRemainder: "38765432110",
    },
    streamLength: 300,
    seed: 13,
    reconciliation: { status: "ok", checkedAt: CHECKED_AT },
  },
  {
    channel: {
      id: "ch-drift-06",
      counterparty: "GDRIFT...PQR",
      asset: "USDC",
      deposit: "2000000000",
      committed: "1500000000",
      sequence: 11,
      status: "closed",
      network: "testnet",
      openTxHash: "open-tx-drift-06",
      openedAt: "2026-11-05T11:00:00.000Z",
      lastCommitAt: "2026-11-19T13:20:00.000Z",
      settlementTxHash: "settle-tx-drift-06",
      returnedRemainder: "600000000",
    },
    streamLength: 12,
    seed: 17,
    missingSequence: 4,
    reconciliation: {
      status: "drift",
      checkedAt: CHECKED_AT,
      drift: [
        {
          kind: "under-settled",
          detail: "Settled 1,400.00 USDC for a cumulative commitment of 1,500.00 USDC.",
        },
        { kind: "sequence-gap", detail: "Sequence 4 is missing from the stream." },
      ],
    },
  },
];

/**
 * A commitment stream for a stub channel. A Park-Miller generator spreads the
 * committed amount over the sequence, and the last commitment lands exactly
 * on the committed total. Every product stays below 2^53.
 */
function buildStream(entry: StubEntry): Commitment[] {
  const { channel, streamLength, seed } = entry;
  if (streamLength === 0) return [];

  let state = seed;
  const weights: bigint[] = [];
  for (let i = 0; i < streamLength; i += 1) {
    state = (state * 16807) % 2147483647;
    weights.push(BigInt((state % 100) + 1));
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  const committed = BigInt(channel.committed);

  const stream: Commitment[] = [];
  let running = 0n;
  for (let sequence = 0; sequence < streamLength; sequence += 1) {
    const weight = weights[sequence] ?? 1n;
    running = sequence === streamLength - 1 ? committed : running + (committed * weight) / total;
    if (sequence === entry.missingSequence) continue;
    stream.push({
      channelId: channel.id,
      sequence,
      cumulativeAmount: running.toString(),
      commitment: `stub-signature:${channel.id}:${sequence}`,
    });
  }
  return stream;
}
