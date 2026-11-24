/**
 * Live reconciliation of open MPP payment channels (#212).
 *
 * docs/design.md, "Reconciliation": the engine compares the stored channel
 * against the channel contract state while the channel is still open, so an
 * unexpected close or a wrong contract is caught while there is time to act.
 * This module is the comparison only: it takes the on-chain state already read
 * and parsed (chain.ts) and needs no SDK and no network.
 *
 * What the chain can prove before close. From the one-way-channel contract
 * that @stellar/mpp 0.7.1 drives (`contracts/channel/src/lib.rs` in
 * stellar-experimental/one-way-channel):
 *
 * - `balance()` is the token balance the contract holds. `top_up` raises it
 *   without an event, and anyone can transfer tokens to the contract, so a
 *   balance above the deposit proves nothing.
 * - Before a close takes effect, tokens leave only through `settle` and
 *   `close`, which pay the recipient up to a cumulative amount the funder
 *   signed. `refund` needs an effective close.
 *
 * So while the channel is open the balance can never fall below the deposit
 * minus everything committed. A lower balance means tokens left for a
 * commitment Tollway did not record. Off-chain commitments themselves are
 * invisible to the chain, and are checked against the settlement by
 * `reconcileChannel` after close.
 */

import type { StellarNetwork } from "@vegaforge/tollway-core";
import type { OnChainChannelState } from "./chain.js";

export type OpenChannelDriftKind =
  /** The channel is open locally, but a close has started or settled on chain. */
  | "closed-on-chain"
  /** The contract pays a different recipient than the channel's counterparty. */
  | "recipient-mismatch"
  /** The contract was funded by a different address than expected. */
  | "funder-mismatch"
  /** The contract holds a different token than the channel's asset. */
  | "token-mismatch"
  /** Tokens left the contract beyond what was committed. */
  | "balance-mismatch"
  /** A snapshot amount is not a non-negative integer string. */
  | "malformed-record";

export type OpenChannelDrift = { kind: OpenChannelDriftKind; detail: string };

/**
 * What Tollway knows about an open channel, without importing
 * `@vegaforge/tollway-channels`. Build it from a channel record with
 * `openChannelSnapshot` from `@vegaforge/tollway-reconcile/stellar`, which
 * also resolves `tokenContract`.
 */
export type OpenChannelSnapshot = {
  /** The channel contract address. */
  channelId: string;
  network: StellarNetwork;
  /** The local lifecycle status, such as `open` or `closing`. */
  status: string;
  /** The recipient the channel pays. */
  counterparty: string;
  /** The token contract address of the channel's asset. */
  tokenContract: string;
  /** The deposit, as an integer string in the token's smallest unit. */
  deposit: string;
  /** The highest cumulative amount committed, as an integer string. */
  committed: string;
  /**
   * The expected funder. The channel record does not store it, so it comes
   * from configuration. When omitted, the funder is not checked.
   */
  funder?: string;
};

const AMOUNT_RE = /^[0-9]+$/;

/**
 * Compares an open channel's snapshot with its on-chain state and returns
 * every drift item found. Pure: no I/O.
 */
export function reconcileOpenChannel(
  snapshot: OpenChannelSnapshot,
  state: OnChainChannelState,
): OpenChannelDrift[] {
  const drift: OpenChannelDrift[] = [];

  for (const field of ["deposit", "committed"] as const) {
    if (!AMOUNT_RE.test(snapshot[field])) {
      drift.push({
        kind: "malformed-record",
        detail: `snapshot.${field} "${snapshot[field]}" is not a valid non-negative integer string`,
      });
    }
  }

  const closing = state.closeEffectiveAtLedger !== null;
  if (snapshot.status === "open" && state.closeEffectiveAtLedger !== null) {
    const left = state.closeEffectiveAtLedger - state.currentLedger;
    drift.push({
      kind: "closed-on-chain",
      detail:
        left > 0
          ? `channel ${snapshot.channelId} is open locally, but its close takes effect at ledger ${state.closeEffectiveAtLedger} (current ledger ${state.currentLedger}, ${left} ledgers left to settle)`
          : `channel ${snapshot.channelId} is open locally, but its close took effect at ledger ${state.closeEffectiveAtLedger} (current ledger ${state.currentLedger}); the funder can now refund the balance`,
    });
  }

  if (state.to !== snapshot.counterparty) {
    drift.push({
      kind: "recipient-mismatch",
      detail: `expected recipient ${snapshot.counterparty}, but the contract pays ${state.to}`,
    });
  }

  if (snapshot.funder !== undefined && state.from !== snapshot.funder) {
    drift.push({
      kind: "funder-mismatch",
      detail: `expected funder ${snapshot.funder}, but the contract was funded by ${state.from}`,
    });
  }

  if (state.token !== snapshot.tokenContract) {
    drift.push({
      kind: "token-mismatch",
      detail: `expected token contract ${snapshot.tokenContract}, but the contract holds ${state.token}`,
    });
  }

  // Only meaningful while no close is pending: once a close is effective the
  // funder may refund, and the balance legitimately drops to zero.
  const amountsValid = AMOUNT_RE.test(snapshot.deposit) && AMOUNT_RE.test(snapshot.committed);
  if (amountsValid && !closing) {
    const floor = BigInt(snapshot.deposit) - BigInt(snapshot.committed);
    const balance = BigInt(state.balance);
    if (floor > 0n && balance < floor) {
      drift.push({
        kind: "balance-mismatch",
        detail: `expected the contract to hold at least ${floor} (deposit ${snapshot.deposit} minus committed ${snapshot.committed}), but it holds ${balance}; ${floor - balance} left the channel beyond what was committed`,
      });
    }
  }

  return drift;
}
