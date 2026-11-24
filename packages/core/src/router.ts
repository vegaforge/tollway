import { TollwayError } from "./errors.js";
import type { CounterpartyQuarantine } from "./quarantine.js";
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

/** Everything the router weighs when it picks a settlement model for one payment. */
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
  /**
   * Caller-supplied quarantine flag. When true, `mpp-channel` is excluded
   * from selection.
   */
  quarantined?: boolean;
};

/**
 * Why the router chose a model: an explicit override, the counterparty's
 * offer, observed traffic, quarantine exclusion, or the fallback when nothing
 * else applies.
 */
export type RouteReason = "override" | "offer" | "traffic" | "default" | "quarantined";

/** The model the router chose and the reason, so the choice can be logged and explained. */
export type RouteDecision = {
  model: SettlementModel;
  reason: RouteReason;
};

/**
 * Decides how a payment settles. {@link createDefaultRouter} is the built-in
 * implementation; see docs/design.md, "The model router".
 */
export interface ModelRouter {
  decide(input: RouteInput): Promise<RouteDecision>;
}

/** Cheapest accountable model first; channels only pay off under sustained load. */
const preferenceOrder: readonly SettlementModel[] = ["x402", "mpp-charge", "mpp-channel"];

export type DefaultRouterOptions = {
  /**
   * Optional quarantine store. When provided, `mpp-channel` is excluded for
   * quarantined counterparties, and a lookup failure fails closed by excluding
   * `mpp-channel`.
   */
  quarantine?: CounterpartyQuarantine;
};

async function isCounterpartyQuarantined(
  input: RouteInput,
  quarantine?: CounterpartyQuarantine,
): Promise<boolean> {
  if (input.quarantined) return true;
  if (!quarantine) return false;
  try {
    const entry = await quarantine.lookup(input.counterparty);
    return entry !== undefined;
  } catch {
    // Fail closed: if quarantine standing cannot be verified, do not route
    // new commitments to mpp-channel.
    return true;
  }
}

/**
 * The default router: an override wins (unless `mpp-channel` is requested for
 * a quarantined counterparty), otherwise the first model both the offer and
 * policy accept (excluding `mpp-channel` when quarantined), otherwise x402 for
 * an unknown counterparty.
 *
 * TODO: promote a counterparty to channel mode once traffic crosses the
 * threshold and @vegaforge/tollway-channels can run the lifecycle. The threshold is an
 * open question; see docs/design.md, "Open questions", item 5.
 */
export function createDefaultRouter(options: DefaultRouterOptions = {}): ModelRouter {
  const { quarantine } = options;

  return {
    async decide(input: RouteInput): Promise<RouteDecision> {
      const quarantined = await isCounterpartyQuarantined(input, quarantine);

      if (input.override) {
        if (input.override === "mpp-channel" && quarantined) {
          throw new TollwayError(
            "counterparty-quarantined",
            `counterparty "${input.counterparty}" is quarantined; cannot override to mpp-channel`,
          );
        }
        return { model: input.override, reason: "override" };
      }

      const allowed = input.allowedModels ?? [...settlementModels];
      const effectiveAllowed = quarantined
        ? allowed.filter((model) => model !== "mpp-channel")
        : allowed;

      if (input.offer) {
        const viable = preferenceOrder.find(
          (model) => input.offer?.models.includes(model) && effectiveAllowed.includes(model),
        );
        if (!viable) {
          throw new TollwayError(
            "no-viable-model",
            quarantined
              ? `counterparty "${input.counterparty}" is quarantined (mpp-channel excluded); offer for ${input.offer.resource} accepts [${input.offer.models.join(", ")}], policy allows [${effectiveAllowed.join(", ")}]`
              : `offer for ${input.offer.resource} accepts [${input.offer.models.join(", ")}], policy allows [${effectiveAllowed.join(", ")}]`,
          );
        }
        return { model: viable, reason: quarantined ? "quarantined" : "offer" };
      }

      if (!effectiveAllowed.includes("x402")) {
        const fallback = preferenceOrder.find((model) => effectiveAllowed.includes(model));
        if (!fallback) {
          throw new TollwayError(
            "no-viable-model",
            quarantined
              ? `counterparty "${input.counterparty}" is quarantined and no non-channel model is allowed`
              : "policy allows no settlement model",
          );
        }
        return { model: fallback, reason: quarantined ? "quarantined" : "default" };
      }
      return { model: "x402", reason: quarantined ? "quarantined" : "default" };
    },
  };
}
