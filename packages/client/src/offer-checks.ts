/**
 * Offer sanity checks (#209).
 *
 * A 402 challenge is attacker-controlled input. These checks run in
 * `createClient().pay()` before the policy engine and before the settler, so
 * an offer that breaks a configured bound is refused before any signature is
 * produced or any budget is touched. They apply to every settlement model.
 *
 * Policy is spend over time; these are per-offer validity checks, so they are
 * deliberately separate from `createPolicyEngine`.
 *
 * Always applied, with no configuration:
 * - network: the offer's network must equal the client's network.
 * - structural: `amount` is an integer string in base units and is not zero
 *   (unless `allowZeroAmount` is set); `models` is non-empty; `payTo` and
 *   `asset` are non-empty; and the offer's resource names the URL the agent
 *   requested, under the same path-and-query rule the receipt binding uses
 *   (#202).
 *
 * Applied when configured:
 * - maxAmount: a ceiling per asset. When `maxAmount` is set, an asset with no
 *   entry is refused (fail closed): an operator who sets price limits has said
 *   which assets they expect, and an unknown asset must not slip through.
 * - allowedPayees and allowedAssets: exact-string allowlists.
 */

import type { PaymentOffer, StellarNetwork } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";
import { resourceIdentity } from "./receipt-binding.js";

/** Per-client offer checks. Every field is optional. */
export type OfferChecks = {
  /**
   * Largest amount accepted per asset, as integer strings in the asset's
   * smallest unit. When present, an asset with no entry is refused.
   */
  maxAmount?: Readonly<Record<string, string>>;
  /** Exact-string allowlist of payee addresses. */
  allowedPayees?: readonly string[];
  /** Exact-string allowlist of asset identifiers. */
  allowedAssets?: readonly string[];
  /**
   * The network offers must name. Defaults to the client's `network`. It must
   * equal that network when set: the client settles on one network, and its
   * receipts are bound to it.
   */
  requireNetwork?: StellarNetwork;
  /**
   * Accept an offer whose amount is zero. Off by default, because a free
   * offer that still asks for a signature is more likely a probe than a sale.
   */
  allowZeroAmount?: boolean;
};

/** The checks an offer can fail, as reported in `checkName`. */
export type OfferCheckName =
  | "structural"
  | "network"
  | "allowedAssets"
  | "maxAmount"
  | "allowedPayees";

/**
 * Thrown when an offer fails a check. A `TollwayError` with code
 * `offer-rejected`; `checkName` names the check that refused it.
 */
export class OfferRejectedError extends TollwayError {
  readonly checkName: OfferCheckName;

  constructor(checkName: OfferCheckName, detail: string) {
    super("offer-rejected", `offer rejected by check "${checkName}": ${detail}`);
    this.name = "OfferRejectedError";
    this.checkName = checkName;
  }
}

const INTEGER_AMOUNT = /^[0-9]+$/;

/**
 * Validates an `offerChecks` configuration once, when the client or settler
 * is created, so a typo in a ceiling fails at startup rather than on the
 * first payment. Throws `TypeError` naming the bad field.
 */
export function validateOfferChecks(checks: OfferChecks, clientNetwork: StellarNetwork): void {
  if (checks.maxAmount !== undefined) {
    for (const [asset, ceiling] of Object.entries(checks.maxAmount)) {
      if (asset.length === 0) {
        throw new TypeError("offerChecks.maxAmount has an empty asset key");
      }
      if (typeof ceiling !== "string" || !INTEGER_AMOUNT.test(ceiling)) {
        throw new TypeError(
          `offerChecks.maxAmount["${asset}"] must be an integer string in the asset's smallest unit, got ${JSON.stringify(ceiling)}`,
        );
      }
    }
  }
  for (const field of ["allowedPayees", "allowedAssets"] as const) {
    const list = checks[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item === "")) {
      throw new TypeError(`offerChecks.${field} must be an array of non-empty strings`);
    }
  }
  if (checks.requireNetwork !== undefined && checks.requireNetwork !== clientNetwork) {
    throw new TypeError(
      `offerChecks.requireNetwork is "${checks.requireNetwork}" but the client settles on "${clientNetwork}"; a client can only pay offers on its own network`,
    );
  }
}

/**
 * Runs the built-in and configured checks. Throws `OfferRejectedError` on the
 * first failure, in this order: structural, network, allowedAssets,
 * maxAmount, allowedPayees.
 */
export function runOfferChecks(
  offer: PaymentOffer,
  requestResource: string,
  clientNetwork: StellarNetwork,
  checks?: OfferChecks,
): void {
  checkStructural(offer, requestResource, checks?.allowZeroAmount === true);
  checkNetwork(offer, checks?.requireNetwork ?? clientNetwork);
  if (checks) {
    checkAllowedAssets(offer, checks);
    checkMaxAmount(offer, checks);
    checkAllowedPayees(offer, checks);
  }
}

/** True when the option passes the payee and asset allowlists. */
export function passesAllowlists(
  option: { payTo: string; asset: string },
  checks: OfferChecks | undefined,
): boolean {
  if (checks?.allowedPayees && !checks.allowedPayees.includes(option.payTo)) return false;
  if (checks?.allowedAssets && !checks.allowedAssets.includes(option.asset)) return false;
  return true;
}

function checkStructural(offer: PaymentOffer, requestResource: string, allowZero: boolean): void {
  if (typeof offer.payTo !== "string" || offer.payTo.trim() === "") {
    throw new OfferRejectedError("structural", "offer.payTo is empty");
  }
  if (typeof offer.asset !== "string" || offer.asset.trim() === "") {
    throw new OfferRejectedError("structural", "offer.asset is empty");
  }
  if (!Array.isArray(offer.models) || offer.models.length === 0) {
    throw new OfferRejectedError("structural", "offer.models is empty");
  }
  if (typeof offer.amount !== "string" || !INTEGER_AMOUNT.test(offer.amount)) {
    throw new OfferRejectedError(
      "structural",
      `offer.amount ${JSON.stringify(offer.amount)} is not an integer string in base units`,
    );
  }
  if (!allowZero && BigInt(offer.amount) === 0n) {
    throw new OfferRejectedError(
      "structural",
      "offer.amount is zero; set offerChecks.allowZeroAmount to accept free offers",
    );
  }
  if (resourceIdentity(offer.resource) !== resourceIdentity(requestResource)) {
    throw new OfferRejectedError(
      "structural",
      `the offer is for "${resourceIdentity(offer.resource)}" but the agent requested "${resourceIdentity(requestResource)}"`,
    );
  }
}

function checkNetwork(offer: PaymentOffer, required: StellarNetwork): void {
  if (offer.network !== required) {
    throw new OfferRejectedError(
      "network",
      `offer is for network "${offer.network}" but the client requires "${required}"`,
    );
  }
}

function checkAllowedAssets(offer: PaymentOffer, checks: OfferChecks): void {
  if (checks.allowedAssets && !checks.allowedAssets.includes(offer.asset)) {
    throw new OfferRejectedError(
      "allowedAssets",
      `asset "${offer.asset}" is not in the allowed-assets list`,
    );
  }
}

function checkMaxAmount(offer: PaymentOffer, checks: OfferChecks): void {
  if (!checks.maxAmount) return;
  // Object.hasOwn, so an asset named like an Object.prototype member never
  // finds an inherited value.
  const ceiling = Object.hasOwn(checks.maxAmount, offer.asset)
    ? checks.maxAmount[offer.asset]
    : undefined;
  if (ceiling === undefined) {
    throw new OfferRejectedError(
      "maxAmount",
      `asset "${offer.asset}" has no maxAmount entry, and maxAmount fails closed`,
    );
  }
  // validateOfferChecks has already proved the ceiling is an integer string.
  if (BigInt(offer.amount) > BigInt(ceiling)) {
    throw new OfferRejectedError(
      "maxAmount",
      `offer amount ${offer.amount} exceeds the maximum ${ceiling} for asset "${offer.asset}"`,
    );
  }
}

function checkAllowedPayees(offer: PaymentOffer, checks: OfferChecks): void {
  if (checks.allowedPayees && !checks.allowedPayees.includes(offer.payTo)) {
    throw new OfferRejectedError(
      "allowedPayees",
      `payee "${offer.payTo}" is not in the allowed-payees list`,
    );
  }
}
