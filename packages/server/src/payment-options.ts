import type { SettlementModel, StellarNetwork } from "@vegaforge/tollway-core";
import type { PaymentRequirements } from "@x402/core/types";
import { type FacilitatorClient, toPaymentRequirements, type X402Terms } from "./facilitator.js";
import type { DynamicPriceFunction, PaywallConfig } from "./gate.js";

/**
 * Payment options (#158): the single-option fields and `accepts` normalised
 * to one list, and the exact match of a payer's `accepted` against it.
 */

/** One payment option as the gate uses it, with its facilitator resolved. */
export type ResolvedPaymentOption = {
  /** 1-based position in the service's preference order, for messages. */
  position: number;
  amount: string | DynamicPriceFunction;
  asset: string;
  payTo: string;
  network: StellarNetwork;
  facilitatorUrl?: string;
  terms: X402Terms;
  /** Undefined only when the paywall does not accept x402. */
  facilitator?: FacilitatorClient;
};

const INTEGER_AMOUNT = /^[0-9]+$/;

/**
 * Normalises a paywall's payment options and checks them, so a broken list
 * fails at `createPaywall`, not on the first paid request. A single-option
 * config becomes a one-item list with exactly its old terms.
 */
export function resolvePaymentOptions(
  config: PaywallConfig,
  defaultFacilitator: FacilitatorClient | undefined,
  models: readonly SettlementModel[],
): ResolvedPaymentOption[] {
  const needsFacilitator = models.includes("x402");
  if (config.accepts === undefined) {
    if (needsFacilitator && !defaultFacilitator) {
      throw new TypeError("createPaywall needs PaywallDeps.facilitator to settle x402 payments");
    }
    return [
      {
        position: 1,
        amount: config.amount,
        asset: config.asset,
        payTo: config.payTo,
        network: config.network,
        ...(config.facilitatorUrl === undefined ? {} : { facilitatorUrl: config.facilitatorUrl }),
        terms: { maxTimeoutSeconds: config.maxTimeoutSeconds, extra: config.extra },
        ...(defaultFacilitator ? { facilitator: defaultFacilitator } : {}),
      },
    ];
  }

  if (config.accepts.length === 0) {
    throw new TypeError("accepts must list at least one payment option");
  }
  const options = config.accepts.map((option, index): ResolvedPaymentOption => {
    const position = index + 1;
    if (typeof option.amount !== "string" || !INTEGER_AMOUNT.test(option.amount)) {
      throw new TypeError(
        `payment option ${position} amount must be a non-negative integer string in the asset's smallest unit`,
      );
    }
    const facilitator = option.facilitator ?? defaultFacilitator;
    if (needsFacilitator && !facilitator) {
      throw new TypeError(
        `payment option ${position} (${option.network} ${option.asset}) has no facilitator: set its facilitator or PaywallDeps.facilitator`,
      );
    }
    return {
      position,
      amount: option.amount,
      asset: option.asset,
      payTo: option.payTo,
      network: option.network,
      ...(option.facilitatorUrl === undefined ? {} : { facilitatorUrl: option.facilitatorUrl }),
      terms: { maxTimeoutSeconds: option.maxTimeoutSeconds, extra: option.extra },
      ...(facilitator ? { facilitator } : {}),
    };
  });
  // Two options with the same terms could never be told apart by a payment.
  const seen = new Map<string, number>();
  for (const option of options) {
    const key = matchKey(requirementsFor(option, option.amount as string));
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new TypeError(
        `payment options ${earlier} and ${option.position} have the same terms; a payment could not tell them apart`,
      );
    }
    seen.set(key, option.position);
  }
  return options;
}

/** The x402 requirements an option advertises at a given amount. */
export function requirementsFor(
  option: ResolvedPaymentOption,
  amount: string,
  quote?: string,
): PaymentRequirements {
  return toPaymentRequirements(
    {
      resource: "",
      amount,
      asset: option.asset,
      payTo: option.payTo,
      network: option.network,
      models: [],
      ...(quote === undefined ? {} : { quote }),
    },
    option.terms,
  );
}

/**
 * The fields a payment must match exactly. `extra` is not among them: it
 * carries client-only and scheme data, and the dynamic-price quote inside it
 * is checked separately. Everything that decides who is paid, how much, in
 * what, where, and for how long is.
 */
function matchKey(requirements: PaymentRequirements): string {
  return JSON.stringify([
    requirements.scheme,
    requirements.network,
    requirements.asset,
    requirements.payTo,
    requirements.amount,
    requirements.maxTimeoutSeconds,
  ]);
}

/**
 * Finds the option the payer chose, by exact match of its `accepted` against
 * the requirements the gate itself advertises. Nothing is ever taken from
 * `accepted`: a payment that names terms the service did not offer (a smaller
 * amount, another payee) matches nothing and is refused.
 */
export function matchAcceptedOption<T extends { requirements: PaymentRequirements }>(
  candidates: readonly T[],
  accepted: PaymentRequirements,
): T | undefined {
  const wanted = matchKey(accepted);
  return candidates.find((candidate) => matchKey(candidate.requirements) === wanted);
}
