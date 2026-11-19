import {
  bytesToBase64Url,
  type PaymentOffer,
  type SettlementModel,
  type StellarNetwork,
  settlementModels,
  stellarNetworks,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { parsePaymentRequired } from "@x402/core/schemas";
import type { Network, PaymentRequired } from "@x402/core/types";

export type ChallengeInput = {
  resource: string;
  amount: string;
  asset: string;
  payTo: string;
  network: string;
  models: readonly string[];
};

export type EncodedChallenge = {
  /** x402 V2 `PaymentRequired`, standard base64, as `encodePaymentRequiredHeader` writes it. */
  x402Base64: string;
  /** Tollway `PaymentOffer`, base64url, as the server's `encodeHeader` writes it today. */
  tollwayBase64Url: string;
};

export type EncodeResult =
  | { ok: true; encoded: EncodedChallenge }
  | { ok: false; errors: Partial<Record<keyof ChallengeInput, string>> };

/** The CAIP-2 ids `createHttpFacilitator` maps Tollway networks to. */
const caip2: Record<StellarNetwork, Network> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

/** Same default as `createHttpFacilitator` in `packages/server/src/facilitator.ts`. */
const MAX_TIMEOUT_SECONDS = 60;

const INTEGER_STRING = /^[0-9]+$/;

function isNetwork(value: string): value is StellarNetwork {
  return (stellarNetworks as readonly string[]).includes(value);
}

function isModel(value: string): value is SettlementModel {
  return (settlementModels as readonly string[]).includes(value);
}

/**
 * Builds the same challenge in both encodings. Every field is checked first
 * and every problem is reported at once, keyed by field, so the form can put
 * each message next to its input.
 */
export function encodeChallenge(input: ChallengeInput): EncodeResult {
  const errors: Partial<Record<keyof ChallengeInput, string>> = {};
  const resource = input.resource.trim();
  const amount = input.amount.trim();
  const asset = input.asset.trim();
  const payTo = input.payTo.trim();

  if (resource === "") errors.resource = "Enter the resource URL or identifier.";
  if (!INTEGER_STRING.test(amount)) {
    errors.amount =
      "Enter the amount as an integer string in the asset's smallest unit, for example 10000 for 0.001 USDC.";
  }
  if (asset === "") errors.asset = "Enter the asset contract address.";
  if (payTo === "") errors.payTo = "Enter the Stellar address that receives the payment.";
  if (!isNetwork(input.network)) errors.network = "Choose testnet or mainnet.";
  const models = input.models.filter(isModel);
  if (models.length === 0 || models.length !== input.models.length) {
    errors.models = "Choose at least one settlement model.";
  }
  if (Object.keys(errors).length > 0 || !isNetwork(input.network)) {
    return { ok: false, errors };
  }

  const offer: PaymentOffer = {
    resource,
    amount,
    asset,
    payTo,
    network: input.network,
    models,
  };
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: resource },
    accepts: [
      {
        scheme: "exact",
        network: caip2[input.network],
        amount,
        asset,
        payTo,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: {},
      },
    ],
  };
  // The type allows values the x402 schema rejects (an empty string, a
  // malformed network), so the built challenge also goes through the schema
  // x402 clients validate with.
  const checked = parsePaymentRequired(required);
  if (!checked.success) {
    return {
      ok: false,
      errors: { resource: checked.error.issues.map((issue) => issue.message).join("; ") },
    };
  }

  return {
    ok: true,
    encoded: {
      x402Base64: encodePaymentRequiredHeader(required),
      tollwayBase64Url: bytesToBase64Url(utf8Bytes(JSON.stringify(offer))),
    },
  };
}
