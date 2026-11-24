import {
  type PaymentOffer,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  TollwayError,
} from "@vegaforge/tollway-core";

/**
 * Checks that a receipt describes the payment the agent actually made.
 *
 * A valid signature only proves the service signed something. Without this
 * check, a buggy or hostile service could return a correctly signed receipt
 * for a different, cheaper or unrelated payment, and the agent's accounting
 * would trust it. The server holds the same rule for its own cache
 * (`offerBinding` and `receiptBinding` in packages/server/src/gate.ts); this
 * is the agent's side of AGENTS.md checklist item 3.
 */

/** Default allowed distance between `issuedAt` and the client clock: five minutes. */
export const DEFAULT_RECEIPT_MAX_SKEW_MS = 5 * 60_000;

/** The settlement reference each model settles through. */
const SETTLEMENT_KIND_FOR_MODEL: Record<SettlementModel, "transaction" | "channel-commitment"> = {
  x402: "transaction",
  "mpp-charge": "transaction",
  "mpp-channel": "channel-commitment",
};

/**
 * Thrown when a receipt does not match the offer that was paid. `field`
 * names the first field that differs, so a caller can log or alert on it
 * without the receipt itself, which never goes into the message.
 */
export class ReceiptOfferMismatchError extends TollwayError {
  readonly field: string;
  constructor(field: string, detail: string) {
    super("receipt-offer-mismatch", `receipt does not match the paid offer: ${field} ${detail}`);
    this.name = "ReceiptOfferMismatchError";
    this.field = field;
  }
}

/** Thrown before payment when an offer is for a different network than the client's. */
export class OfferNetworkMismatchError extends TollwayError {
  constructor(offerNetwork: string, clientNetwork: StellarNetwork) {
    super(
      "offer-network-mismatch",
      `offer is for network "${offerNetwork}" but the client pays on "${clientNetwork}"`,
    );
    this.name = "OfferNetworkMismatchError";
  }
}

/**
 * The resource identity both sides compare: the path and query of a URL.
 * A gate behind an adapter sees only the path (Express passes
 * `req.originalUrl`), while the agent requests a full URL, so the origin is
 * dropped. A value that is not an absolute URL is already a path and is
 * compared as written.
 */
export function resourceIdentity(resource: string): string {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    // Not an absolute URL: it is already the path-and-query form.
    return resource;
  }
  return `${url.pathname}${url.search}`;
}

/**
 * The one rule for whether an offer's resource belongs to the URL the agent
 * requested: their path-and-query identities must be equal. Without it, a
 * service could answer a request for `/report` with a 402 for `/cheap` and a
 * receipt bound to `/cheap`.
 */
export function assertOfferForRequest(requested: string, offer: PaymentOffer): void {
  if (resourceIdentity(requested) !== resourceIdentity(offer.resource)) {
    throw new ReceiptOfferMismatchError(
      "resource",
      `the offer is for "${resourceIdentity(offer.resource)}" but the agent requested "${resourceIdentity(requested)}"`,
    );
  }
}

export type ReceiptBindingInput = {
  receipt: SignedReceipt;
  offer: PaymentOffer;
  model: SettlementModel;
  network: StellarNetwork;
  /** The address the settler paid from, when it can say. */
  payer?: string;
  now: number;
  maxSkewMs: number;
};

function mismatch(field: string, expected: string, actual: string): ReceiptOfferMismatchError {
  return new ReceiptOfferMismatchError(field, `is "${actual}", expected "${expected}"`);
}

/**
 * Throws {@link ReceiptOfferMismatchError} naming the first field of the
 * receipt that does not describe the paid offer. Runs whether or not a
 * verifier is configured; without one the receipt is still unauthenticated.
 */
export function assertReceiptMatchesOffer(input: ReceiptBindingInput): void {
  const { receipt, offer, model, network } = input;
  const body = receipt.receipt;

  // Amounts are integer strings (the schema guarantees `^[0-9]+$`), so a
  // string comparison is exact; "010" and "10" are different signed values.
  const fields: [string, string, string][] = [
    ["amount", offer.amount, body.amount],
    ["asset", offer.asset, body.asset],
    ["payee", offer.payTo, body.payee],
    ["resource", offer.resource, body.resource],
    ["network", network, body.network],
    ["model", model, body.model],
  ];
  for (const [field, expected, actual] of fields) {
    if (expected !== actual) throw mismatch(field, expected, actual);
  }

  // The schema enforces this too; checking it here keeps the rule visible
  // where the binding lives and independent of the schema's refinements.
  const expectedKind = SETTLEMENT_KIND_FOR_MODEL[model];
  if (body.settlement.kind !== expectedKind) {
    throw mismatch("settlement.kind", expectedKind, body.settlement.kind);
  }

  if (input.payer !== undefined && body.payer !== input.payer) {
    throw mismatch("payer", input.payer, body.payer);
  }

  const issuedAt = Date.parse(body.issuedAt);
  if (Math.abs(issuedAt - input.now) > input.maxSkewMs) {
    throw new ReceiptOfferMismatchError(
      "issuedAt",
      `${body.issuedAt} is more than ${input.maxSkewMs}ms from the client clock`,
    );
  }
}
