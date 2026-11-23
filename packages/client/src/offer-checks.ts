/**
 * Offer sanity checks.
 *
 * A 402 challenge is attacker-controlled input. These checks run before the
 * policy engine and before the settler so an offer that violates a configured
 * bound is rejected before any signature is produced or any budget is debited.
 *
 * Policy is spend over time; these are per-offer validity checks. They are
 * intentionally separate from createPolicyEngine.
 *
 * ## Checks applied
 *
 * ### Always applied (no configuration required)
 * - **network** – The offer's network must equal the client's network.
 * - **structural** – `amount` matches `/^[0-9]+$/` and is not zero;
 *   `models` is non-empty; `payTo` and `asset` are non-empty strings;
 *   `offer.resource` equals `request.resource` (consistent with #202).
 *
 * ### Applied when `offerChecks` is configured
 * - **maxAmount** – Per-asset price ceiling as integer strings. An asset
 *   with no entry in `maxAmount` is **rejected** (fail-closed). Pass an
 *   empty map to allow any amount for any asset.
 * - **allowedPayees** – Exact-string allowlist. Any `payTo` not in the set
 *   is rejected.
 * - **allowedAssets** – Exact-string allowlist. Any `asset` not in the set
 *   is rejected.
 *
 * ## Fail-closed behaviour for maxAmount
 *
 * When `maxAmount` is configured, an offer whose asset has no entry in the
 * map is **always rejected**, even if no other check would have failed. This
 * is intentional: an operator who sets price limits has expressed intent
 * about which assets are acceptable. An unknown asset that slips through
 * silently would violate that intent. To allow an asset with no ceiling,
 * add it to the map with a value of `"0"` — that rejects every offer for
 * that asset, which is likely not what you want — or use `allowedAssets`
 * without `maxAmount` when you need a whitelist without per-asset ceilings.
 * The correct way to allow any amount for a known asset is to omit
 * `maxAmount` entirely, or set the entry to the maximum sensible bigint for
 * that asset.
 */

import type { PaymentOffer, StellarNetwork } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-call offer validation options. All fields are optional; omitting a
 * field disables that check.
 */
export type OfferChecks = {
  /**
   * Maximum amount per asset, as integer strings. When present, an asset
   * not in this map is rejected (fail-closed). See module doc for details.
   */
  maxAmount?: Record<string, string>;
  /**
   * Exact-string allowlist of payee addresses. When present, a `payTo` not
   * in this set is rejected. Do not use glob patterns; exact match only.
   */
  allowedPayees?: string[];
  /**
   * Exact-string allowlist of asset identifiers. When present, an `asset`
   * not in this set is rejected.
   */
  allowedAssets?: string[];
  /**
   * Override the network that offers must declare. Defaults to the client's
   * configured `network` when omitted — the network check always fires, but
   * this field lets a caller override which network is required (useful when
   * one client instance serves multiple network contexts).
   */
  requireNetwork?: StellarNetwork;
};

/**
 * Thrown when an offer fails one of the sanity checks. Extends `TollwayError`
 * with code `"offer-rejected"` so callers can branch on `error.code`.
 * `checkName` names the specific check that fired.
 */
export class OfferRejectedError extends TollwayError {
  readonly checkName: string;
  constructor(checkName: string, detail: string) {
    super("offer-rejected", `offer rejected by check "${checkName}": ${detail}`);
    this.name = "OfferRejectedError";
    this.checkName = checkName;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const INTEGER_AMOUNT = /^[0-9]+$/;

/**
 * Run all configured and built-in offer checks. Throws `OfferRejectedError`
 * on the first failing check. Order: structural → network → allowedAssets →
 * maxAmount → allowedPayees. Structural and network run even when
 * `offerChecks` is not configured.
 *
 * @param offer          The offer from the 402 challenge.
 * @param requestResource The resource URL the client was called with.
 * @param clientNetwork  The network the client is configured for.
 * @param checks         Optional per-call checks. `requireNetwork` overrides
 *                       `clientNetwork` for the network check when present.
 */
export function runOfferChecks(
  offer: PaymentOffer,
  requestResource: string,
  clientNetwork: StellarNetwork,
  checks?: OfferChecks,
): void {
  checkStructural(offer, requestResource);
  // requireNetwork in offerChecks overrides the client-level network.
  const requiredNetwork = checks?.requireNetwork ?? clientNetwork;
  checkNetwork(offer, requiredNetwork);
  if (checks) {
    checkAllowedAssets(offer, checks);
    checkMaxAmount(offer, checks);
    checkAllowedPayees(offer, checks);
  }
}

function checkStructural(offer: PaymentOffer, requestResource: string): void {
  if (!offer.payTo || offer.payTo.trim().length === 0) {
    throw new OfferRejectedError("structural", "offer.payTo is empty");
  }
  if (!offer.asset || offer.asset.trim().length === 0) {
    throw new OfferRejectedError("structural", "offer.asset is empty");
  }
  if (!Array.isArray(offer.models) || offer.models.length === 0) {
    throw new OfferRejectedError("structural", "offer.models is empty");
  }
  if (!INTEGER_AMOUNT.test(offer.amount)) {
    throw new OfferRejectedError(
      "structural",
      `offer.amount "${offer.amount}" is not a non-negative integer string`,
    );
  }
  if (BigInt(offer.amount) === 0n) {
    throw new OfferRejectedError("structural", "offer.amount is zero");
  }
  if (offer.resource !== requestResource) {
    throw new OfferRejectedError(
      "structural",
      `offer.resource "${offer.resource}" does not match request resource "${requestResource}"`,
    );
  }
}

function checkNetwork(offer: PaymentOffer, clientNetwork: StellarNetwork): void {
  if (offer.network !== clientNetwork) {
    throw new OfferRejectedError(
      "network",
      `offer is for network "${offer.network}" but client is configured for "${clientNetwork}"`,
    );
  }
}

function checkAllowedAssets(offer: PaymentOffer, checks: OfferChecks): void {
  if (!checks.allowedAssets) return;
  if (!checks.allowedAssets.includes(offer.asset)) {
    throw new OfferRejectedError(
      "allowedAssets",
      `asset "${offer.asset}" is not in the allowed-assets list`,
    );
  }
}

function checkMaxAmount(offer: PaymentOffer, checks: OfferChecks): void {
  if (!checks.maxAmount) return;

  // Fail-closed: an asset with no entry is rejected.
  const ceiling = checks.maxAmount[offer.asset];
  if (ceiling === undefined) {
    throw new OfferRejectedError(
      "maxAmount",
      `asset "${offer.asset}" has no maxAmount entry (fail-closed: add an entry to allow it)`,
    );
  }

  if (!INTEGER_AMOUNT.test(ceiling)) {
    // A misconfigured ceiling is a programming error; use a plain Error so
    // the operator sees it clearly rather than a typed offer rejection.
    throw new Error(
      `offerChecks.maxAmount["${offer.asset}"] is not a valid integer string: "${ceiling}"`,
    );
  }

  if (BigInt(offer.amount) > BigInt(ceiling)) {
    throw new OfferRejectedError(
      "maxAmount",
      `offer amount ${offer.amount} exceeds maximum ${ceiling} for asset "${offer.asset}"`,
    );
  }
}

function checkAllowedPayees(offer: PaymentOffer, checks: OfferChecks): void {
  if (!checks.allowedPayees) return;
  if (!checks.allowedPayees.includes(offer.payTo)) {
    throw new OfferRejectedError(
      "allowedPayees",
      `payee "${offer.payTo}" is not in the allowed-payees list`,
    );
  }
}
