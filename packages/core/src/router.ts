import { TollwayError } from "./errors.js";
import { type PaymentOffer, type SettlementModel, settlementModels } from "./types.js";

/**
 * The model router decides, per interaction or per counterparty, how a
 * payment should settle. See docs/design.md, "The model router".
 */

/** Observed traffic toward one counterparty, from a rolling counter. */
export type TrafficSnapshot = {
  requestsPerMinute: number;
  windowSeconds: number;
};

export type RouteInput = {
  /** The service (or agent) on the other side of this payment. */
  counterparty: string;
  resource: string;
  /** Declared hints, when the counterparty's offer is already known. */
  offer?: PaymentOffer;
  /** Observed traffic shape, when a counter is running. */
  traffic?: TrafficSnapshot;
  /** Explicit per-route or per-agent configuration. Wins over everything. */
  override?: SettlementModel;
  /** Models the caller's policy permits. Defaults to all three. */
  allowedModels?: SettlementModel[];
};

export type RouteReason = "override" | "offer" | "traffic" | "default";

export type RouteDecision = {
  model: SettlementModel;
  reason: RouteReason;
};

export interface ModelRouter {
  decide(input: RouteInput): Promise<RouteDecision>;
}

/** Cheapest accountable model first; channels only pay off under sustained load. */
const preferenceOrder: readonly SettlementModel[] = ["x402", "mpp-charge", "mpp-channel"];

/**
 * The default router: an override wins, otherwise the first model both the
 * offer and policy accept, otherwise x402 for an unknown counterparty.
 *
 * TODO: promote a counterparty to channel mode once traffic crosses the
 * threshold and @tollway/channels can run the lifecycle. The threshold is an
 * open question; see docs/design.md, "Open questions", item 5.
 */
export function createDefaultRouter(): ModelRouter {
  return {
    async decide(input: RouteInput): Promise<RouteDecision> {
      if (input.override) {
        return { model: input.override, reason: "override" };
      }
      const allowed = input.allowedModels ?? [...settlementModels];
      if (input.offer) {
        const viable = preferenceOrder.find(
          (model) => input.offer?.models.includes(model) && allowed.includes(model),
        );
        if (!viable) {
          throw new TollwayError(
            "no-viable-model",
            `offer for ${input.offer.resource} accepts [${input.offer.models.join(", ")}], policy allows [${allowed.join(", ")}]`,
          );
        }
        return { model: viable, reason: "offer" };
      }
      if (!allowed.includes("x402")) {
        const fallback = preferenceOrder.find((model) => allowed.includes(model));
        if (!fallback) {
          throw new TollwayError("no-viable-model", "policy allows no settlement model");
        }
        return { model: fallback, reason: "default" };
      }
      return { model: "x402", reason: "default" };
    },
  };
}
