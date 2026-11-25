/**
 * The x402 `payment-identifier` extension (#153): the 402 declares it, and a
 * client may put an id of its own choosing in its payment. The gate uses that
 * id, scoped to the payer `/verify` returns, as a second idempotency key
 * beside the envelope digest, so a client that re-signs a payment after a
 * timeout gets its first receipt back instead of paying twice.
 *
 * Everything here comes from `@x402/extensions/payment-identifier` 2.31.
 * See docs/design.md, "Design notes" (duplicate protection).
 */

import type { SettlementModel } from "@vegaforge/tollway-core";
import type { PaymentPayload } from "@x402/core/types";
import {
  declarePaymentIdentifierExtension,
  PAYMENT_IDENTIFIER,
  type PaymentIdentifierExtension,
  validatePaymentIdentifier,
  validatePaymentIdentifierRequirement,
} from "@x402/extensions/payment-identifier";

/** The `extensions` entry every 402 carries. */
export function paymentIdentifierExtensions(
  required: boolean,
): Record<typeof PAYMENT_IDENTIFIER, PaymentIdentifierExtension> {
  return { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(required) };
}

export type PaymentIdentifierRead = { ok: true; id?: string } | { ok: false; reason: string };

/**
 * Reads the client's id from a decoded payment. No extension means no id,
 * unless the route requires one. A malformed extension or id is refused
 * rather than ignored, so a client never believes it is protected when it is
 * not.
 *
 * The client's own `schema` is dropped before validating. The upstream
 * validator compiles whatever schema the extension carries with Ajv, and a
 * schema from the request is attacker input: it could loosen the id rules or
 * cost the gate a compile on every request. The id is checked against the
 * extension's fixed rules instead.
 */
export function readPaymentIdentifier(
  payment: PaymentPayload,
  required: boolean,
): PaymentIdentifierRead {
  const requirement = validatePaymentIdentifierRequirement(payment, required);
  if (!requirement.valid) {
    return { ok: false, reason: invalid(requirement.errors) };
  }
  // Absent the way upstream treats it: no entry, or a falsy one.
  const extension: unknown = payment.extensions?.[PAYMENT_IDENTIFIER];
  if (!extension) return { ok: true };

  const info = isRecord(extension) ? extension.info : undefined;
  const validation = validatePaymentIdentifier({ info });
  if (!validation.valid) {
    return { ok: false, reason: invalid(validation.errors) };
  }
  const id = isRecord(info) && typeof info.id === "string" ? info.id : undefined;
  return id === undefined ? { ok: true } : { ok: true, id };
}

/**
 * The settlement cache key for a payment id. The payer is part of it, so an
 * id another payer reuses never finds this payer's receipt. Neither a Stellar
 * address nor a valid id contains `:`, so the parts cannot run together.
 */
export function paymentIdentifierKey(model: SettlementModel, payer: string, id: string): string {
  return `${model}:payment-id:${payer}:${id}`;
}

function invalid(errors: string[] | undefined): string {
  return `invalid-payment-identifier: ${(errors ?? ["the extension is malformed"]).join("; ")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
