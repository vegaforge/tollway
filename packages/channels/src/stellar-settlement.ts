/**
 * Finds a channel's settlement in the one-way-channel contract's events
 * (issue #176). Like stellar-adapter.ts, this file talks to stellar-sdk, so
 * the manager stays SDK-free.
 *
 * What the contract emits, from `contracts/channel/src/lib.rs` in
 * stellar-experimental/one-way-channel (the contract @stellar/mpp 0.7.1
 * closes): `close(amount, sig)` runs in one transaction and emits, in order,
 *
 * - `withdraw { to, amount }`: the payout to the recipient, `amount` minus
 *   anything already withdrawn, when that is above zero;
 * - `close { effective_at_ledger }` with the transaction's own ledger, unless
 *   a `close_start` had already become effective;
 * - `refund { from, amount }`: the remaining balance back to the funder,
 *   when there is one and the transfer succeeds.
 *
 * `close_start` emits `close` with a future ledger instead, and the funder's
 * `refund` emits only `refund`. So a settlement made by `close` is the
 * transaction carrying a `close` event effective at its own ledger. Its
 * `withdraw` events give the settled amount and its `refund` events the
 * remainder. Tollway never calls the contract's partial `settle`, so the
 * payout equals the cumulative amount closed with.
 */

import { type rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { TollwayError } from "@vegaforge/tollway-core";
import type { FoundChannelSettlement } from "./adapter.js";
import { MissingEventHistoryError } from "./errors.js";

/** The parts of a Soroban RPC server the lookup uses. */
export type SettlementEventSource = {
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>;
  getEvents(request: rpc.Api.GetEventsRequest): Promise<{
    events: ReadonlyArray<
      Pick<
        rpc.Api.EventResponse,
        "topic" | "value" | "txHash" | "ledger" | "inSuccessfulContractCall"
      >
    >;
    cursor: string;
  }>;
};

const PAGE_LIMIT = 200;
/** A bound on the scan, so a busy contract cannot keep the lookup running forever. */
const MAX_PAGES = 500;

type DecodedEvent =
  | { type: "close"; effectiveAtLedger: number }
  | { type: "withdraw" | "refund"; amount: bigint };

/**
 * Scans the channel contract's events from `startLedger` and returns the
 * settlement a `close` made, or `null` when none is on chain yet. Throws
 * `MissingEventHistoryError` when the RPC no longer keeps events back to
 * `startLedger`, so a caller never takes "nothing found" for "nothing
 * happened".
 */
export async function findSettlementInEvents(input: {
  source: SettlementEventSource;
  channelId: string;
  startLedger: number;
}): Promise<FoundChannelSettlement | null> {
  const { source, channelId, startLedger } = input;
  const health = await source.getHealth();
  if (startLedger < health.oldestLedger) {
    throw new MissingEventHistoryError(channelId, startLedger);
  }

  // Collect every event first: one transaction's events can straddle a
  // page boundary, so a transaction is only judged once all are in.
  const filters = [{ type: "contract" as const, contractIds: [channelId] }];
  const collected: SourceEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) {
      throw new MissingEventHistoryError(
        channelId,
        startLedger,
        `scanned ${MAX_PAGES * PAGE_LIMIT} events from ledger ${startLedger} without reaching the end`,
      );
    }
    const response = await source.getEvents(
      cursor === undefined
        ? { filters, startLedger, limit: PAGE_LIMIT }
        : { filters, cursor, limit: PAGE_LIMIT },
    );
    collected.push(...response.events);
    if (response.events.length < PAGE_LIMIT) break;
    cursor = response.cursor;
  }
  return settlementIn(channelId, collected);
}

type SourceEvent = Pick<
  rpc.Api.EventResponse,
  "topic" | "value" | "txHash" | "ledger" | "inSuccessfulContractCall"
>;

/**
 * The earliest transaction with a `close` effective at its own ledger,
 * summarised, or `null` when there is none.
 */
function settlementIn(
  channelId: string,
  events: readonly SourceEvent[],
): FoundChannelSettlement | null {
  const byTx = new Map<string, { ledger: number; events: DecodedEvent[] }>();
  for (const event of events) {
    if (!event.inSuccessfulContractCall) continue;
    const decoded = decode(channelId, event.topic, event.value);
    if (!decoded) continue;
    const entry = byTx.get(event.txHash) ?? { ledger: event.ledger, events: [] };
    entry.events.push(decoded);
    byTx.set(event.txHash, entry);
  }
  for (const [txHash, { ledger, events: txEvents }] of byTx) {
    const settled = txEvents.some(
      (event) => event.type === "close" && event.effectiveAtLedger === ledger,
    );
    if (!settled) continue;
    const sum = (type: "withdraw" | "refund"): bigint =>
      txEvents.reduce((total, event) => (event.type === type ? total + event.amount : total), 0n);
    return {
      settlementTxHash: txHash,
      settledAmount: sum("withdraw").toString(),
      returnedRemainder: sum("refund").toString(),
      settledAtLedger: ledger,
    };
  }
  return null;
}

/**
 * Decodes the three event kinds the lookup needs; `open` and topics it does
 * not know are skipped. A known event whose fields are not what the contract
 * emits is refused: guessing would misreport where the money went.
 */
function decode(
  channelId: string,
  topic: readonly xdr.ScVal[],
  value: xdr.ScVal,
): DecodedEvent | undefined {
  const name = topic[0] === undefined ? undefined : symbolOf(topic[0]);
  if (name !== "close" && name !== "withdraw" && name !== "refund") return undefined;
  const fields: unknown = scValToNative(value);
  const record =
    typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>) : {};
  if (name === "close" && typeof record.effective_at_ledger === "number") {
    return { type: "close", effectiveAtLedger: record.effective_at_ledger };
  }
  if (name !== "close" && typeof record.amount === "bigint") {
    return { type: name, amount: record.amount };
  }
  throw new TollwayError(
    "settlement-mismatch",
    `channel ${channelId} emitted a ${name} event this client cannot read; refusing to guess the settlement`,
  );
}

function symbolOf(value: xdr.ScVal): string | undefined {
  return value.switch().name === "scvSymbol" ? value.sym().toString() : undefined;
}
