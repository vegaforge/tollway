import { TollwayError } from "./errors.js";
import { type PaymentOffer, type SettlementModel, settlementModels } from "./types.js";

/**
 * The model router decides, per interaction or per counterparty, how a
 * payment should settle. See docs/design.md, "The model router".
 */

/**
 * A measurement of recent request volume for one counterparty.
 *
 * The router currently accepts this as contextual input; the default router
 * does not yet use it to promote a counterparty to channel settlement.
 * Producers should report the actual measurement window so future routing
 * strategies can distinguish a short burst from sustained traffic.
 */
export type TrafficSnapshot = {
  /** Number of observed requests in the measurement window. */
  requestsPerMinute: number;
  /** Duration, in seconds, over which the observation was collected. */
  windowSeconds: number;
};

/**
 * Context used to choose a settlement model for one payment interaction.
 *
 * The router does not settle funds or change the offer. It selects a model
 * from the models the caller permits and reports why that model was chosen.
 */
export type RouteInput = {
  /** The service (or agent) on the other side of this payment. */
  counterparty: string;
  /** Resource identifier used to associate the decision with the request. */
  resource: string;
  /**
   * Declared settlement options supplied by the counterparty.
   *
   * When present, the default router selects the first model that appears in
   * both this offer and `allowedModels`. An empty intersection is an error.
   */
  offer?: PaymentOffer;
  /**
   * Recent traffic statistics, when a counter is available.
   *
   * This field is reserved for traffic-aware routing strategies. The current
   * default implementation intentionally does not infer channel suitability
   * from this measurement alone.
   */
  traffic?: TrafficSnapshot;
  /**
   * Explicit model selection for this route or counterparty.
   *
   * An override takes precedence over the offer and allowed-model checks in
   * the current default router. The caller is responsible for ensuring that
   * the selected model is valid for the payment flow.
   */
  override?: SettlementModel;
  /**
   * Models permitted by the caller's policy.
   *
   * Omit this field to permit every model known to this version of Tollway.
   * When an offer is present, the selected model must also be offered.
   * An empty list cannot produce a default route and results in an error.
   */
  allowedModels?: SettlementModel[];
};

/**
 * Explains which input determined a routing decision.
 *
 * `override` means explicit caller configuration won.
 * `offer` means the model was selected from the offer and allowed-model set.
 * `traffic` is reserved for traffic-aware strategies.
 * `default` means the router used its fallback preference order.
 */
export type RouteReason = "override" | "offer" | "traffic" | "default";

/**
 * The model selected for a payment and the reason for that selection.
 *
 * This is a routing result only. It is not a guarantee that a facilitator,
 * adapter, or channel lifecycle is configured to complete the settlement.
 */
export type RouteDecision = {
  /** Settlement model the caller should use for this interaction. */
  model: SettlementModel;
  /** Input category that determined the selected model. */
  reason: RouteReason;
};

/**
 * Strategy interface for selecting a settlement model.
 *
 * Implementations may use static configuration, offer capabilities, or
 * observed traffic. They should reject with `no-viable-model` when no model
 * satisfies the inputs rather than silently selecting a disallowed model.
 */
export interface ModelRouter {
  /** Resolves the model to use for one payment interaction. */
  decide(input: RouteInput): Promise<RouteDecision>;
}

/** Cheapest accountable model first; channels only pay off under sustained load. */
const preferenceOrder: readonly SettlementModel[] = ["x402", "mpp-charge", "mpp-channel"];

/**
 * The default router: an override wins, otherwise the first model both the
 * offer and policy accept, otherwise x402 for an unknown counterparty.
 *
 * TODO: promote a counterparty to channel mode once traffic crosses the
 * threshold and @vegaforge/tollway-channels can run the lifecycle. The threshold is an
 * open question; see docs/design.md, "Open questions", item 5.
 */
/**
 * Creates Tollway's deterministic default model-selection strategy.
 *
 * The preference order is x402, then mpp-charge, then mpp-channel.
 * An explicit override is returned first. With an offer, the first model
 * accepted by both the offer and policy is selected. Without an offer, x402
 * is preferred when allowed, otherwise the first allowed fallback is used.
 *
 * This strategy does not currently use `traffic` to switch to channel mode.
 * It throws `TollwayError` with code `no-viable-model` when no candidate is
 * available or when an offer and policy have no model in common.
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
