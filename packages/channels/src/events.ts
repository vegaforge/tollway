/**
 * Channel lifecycle events (#187).
 *
 * Opening and closing a channel lock and release an agent's funds, so the
 * manager reports each step to an optional `onEvent` handler. Events are
 * emitted only after the matching store write has succeeded, carry an ISO
 * timestamp from the manager's clock, and give every amount as an integer
 * string in the asset's smallest unit.
 *
 * The union is open for the recovery events #38 adds (`channel:recovering`,
 * `channel:recovered`): each variant has its own `type`, so a new one joins
 * without changing the others.
 */

import type { StellarNetwork } from "@vegaforge/tollway-core";

/** Fields every lifecycle event carries. */
type ChannelEventBase = {
  /** ISO-8601 time, from the manager's `now`. */
  at: string;
  channelId: string;
  counterparty: string;
  asset: string;
  network: StellarNetwork;
};

/** A channel was opened on chain and recorded. */
export type ChannelOpenedEvent = ChannelEventBase & {
  type: "channel:opened";
  deposit: string;
  openTxHash: string;
};

/**
 * A close was recorded as started, before the close transaction is
 * submitted. `cumulativeAmount` is the commitment being settled.
 */
export type ChannelClosingEvent = ChannelEventBase & {
  type: "channel:closing";
  cumulativeAmount: string;
};

/** A close settled on chain and was recorded. */
export type ChannelClosedEvent = ChannelEventBase & {
  type: "channel:closed";
  settlementTxHash: string;
  /** What the counterparty was paid: the last commitment's cumulative amount. */
  settledAmount: string;
  /** What came back to the funder. */
  returnedRemainder: string;
};

/**
 * A close did not complete. `status` is where the channel was left:
 * `open` when nothing was submitted, `closing` when the outcome is unknown
 * and `resume` must finish it, `settlement-mismatched` when the chain
 * settled a different amount than the last commitment.
 */
export type ChannelCloseFailedEvent = ChannelEventBase & {
  type: "channel:close-failed";
  status: "open" | "closing" | "settlement-mismatched";
  error: Error;
};

export type ChannelLifecycleEvent =
  | ChannelOpenedEvent
  | ChannelClosingEvent
  | ChannelClosedEvent
  | ChannelCloseFailedEvent;

/** Receives lifecycle events. A returned promise is not awaited. */
export type ChannelEventHandler = (event: ChannelLifecycleEvent) => void | Promise<void>;

/**
 * The part of `@vegaforge/tollway-observability`'s hub the bridge uses. It
 * is structural, so this package takes no runtime dependency on
 * observability.
 */
export type ChannelEventSink = {
  emit(event: { type: string; at: string; data: Record<string, unknown> }): Promise<unknown>;
};

export type ObservabilityBridge = {
  /** Pass as the manager's `onEvent`. */
  onEvent: ChannelEventHandler;
  /**
   * Resolves once every delivery started so far has settled. Call it on
   * shutdown so no webhook is left in flight.
   */
  flush(): Promise<void>;
};

/**
 * Maps `channel:opened` and `channel:closed` to the `channel.opened` and
 * `channel.closed` webhooks. The other lifecycle events are not on the
 * webhook list and are not forwarded.
 *
 * Delivery never delays `open` or `close`: the bridge starts it and returns.
 * It keeps each delivery promise until it settles, so `flush()` can wait for
 * them, and reports a failed delivery to `onDeliveryError` instead of
 * leaving a rejected promise behind.
 */
export function toObservabilitySink(
  sink: ChannelEventSink,
  options: { onDeliveryError?: (error: Error, event: ChannelLifecycleEvent) => void } = {},
): ObservabilityBridge {
  const pending = new Set<Promise<void>>();

  function deliver(event: ChannelLifecycleEvent, mapped: Parameters<ChannelEventSink["emit"]>[0]) {
    const delivery = Promise.resolve()
      .then(() => sink.emit(mapped))
      .then(
        () => undefined,
        (raw: unknown) => {
          const error = raw instanceof Error ? raw : new Error(String(raw));
          try {
            options.onDeliveryError?.(error, event);
          } catch {
            // The error hook is the last stop; a throwing hook must not turn
            // into an unhandled rejection.
          }
        },
      )
      .finally(() => {
        pending.delete(delivery);
      });
    pending.add(delivery);
  }

  return {
    onEvent(event) {
      if (event.type === "channel:opened") {
        deliver(event, {
          type: "channel.opened",
          at: event.at,
          data: {
            channelId: event.channelId,
            counterparty: event.counterparty,
            asset: event.asset,
            network: event.network,
            deposit: event.deposit,
            openTxHash: event.openTxHash,
          },
        });
      } else if (event.type === "channel:closed") {
        deliver(event, {
          type: "channel.closed",
          at: event.at,
          data: {
            channelId: event.channelId,
            counterparty: event.counterparty,
            asset: event.asset,
            network: event.network,
            settlementTxHash: event.settlementTxHash,
            settledAmount: event.settledAmount,
            returnedRemainder: event.returnedRemainder,
          },
        });
      }
    },
    async flush() {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}
