/**
 * Reads a 402 into one Tollway `PaymentOffer` before policy or routing sees
 * it (#201). A 402 can carry two challenge formats at once:
 *
 * - x402 V2: `PAYMENT-REQUIRED`, base64 JSON of `PaymentRequired`, decoded
 *   with `@x402/core/http` and then validated here.
 * - MPP: `WWW-Authenticate: Payment ...`, parsed with `mppx`'s `Challenge`.
 *   A Stellar `charge` challenge carries amount, currency and recipient; a
 *   Stellar `channel` challenge carries only an amount and a channel
 *   contract, so it adds `mpp-channel` to an offer but cannot define one.
 *
 * Every advertised model goes on the one offer, and the router's choice
 * decides which settler runs. The formats must agree on the terms: a 402 that
 * asks for one amount over x402 and another over MPP is refused rather than
 * guessed at.
 */

import {
  type PaymentOffer,
  type SettlementModel,
  type StellarNetwork,
  TollwayError,
} from "@vegaforge/tollway-core";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { Challenge } from "mppx";
import { z } from "zod";
import { MPP_NETWORK_ID, offerAssetContract } from "./mpp-charge-settler.js";
import { messageOf } from "./receipt-header.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402-settler.js";

const integerString = z.string().regex(/^[0-9]+$/, "must be an integer string in base units");

/** The parts of an x402 V2 `PaymentRequirements` the offer is built from. Extra fields are allowed. */
const requirementsSchema = z.looseObject({
  scheme: z.string().min(1),
  network: z.string().min(1),
  asset: z.string().min(1),
  amount: integerString,
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive(),
});

const paymentRequiredSchema = z.looseObject({
  x402Version: z.literal(2),
  accepts: z.array(requirementsSchema).min(1),
});

const chargeRequestSchema = z.looseObject({
  amount: integerString,
  currency: z.string().min(1),
  recipient: z.string().min(1),
  methodDetails: z.looseObject({ network: z.string() }).optional(),
});

const channelRequestSchema = z.looseObject({
  amount: integerString,
  channel: z.string().min(1),
  methodDetails: z.looseObject({ network: z.string().optional() }).optional(),
});

/** `@stellar/mpp`'s channel method names networks "testnet" and "public". */
const MPP_CHANNEL_NETWORK: Record<StellarNetwork, readonly string[]> = {
  testnet: ["testnet", "stellar:testnet"],
  mainnet: ["public", "stellar:pubnet"],
};

type Terms = { amount: string; asset: string; payTo: string };

/**
 * The offer a 402 makes, for `resource` on `network`. Rejects with
 * `payment-failed` when a challenge header is malformed, when no challenge
 * fits the network, or when the formats disagree on the terms.
 */
export function offerFromChallenge(
  response: Response,
  resource: string,
  network: StellarNetwork,
): PaymentOffer {
  const models: SettlementModel[] = [];
  const x402 = readX402Terms(response, resource, network);
  if (x402) models.push("x402");
  const mpp = readMppChallenges(response, network);

  let terms: Terms | undefined = x402;
  if (mpp.charge) {
    const charge = mpp.charge;
    if (terms) {
      // x402 names the token contract or a classic asset; MPP always names
      // the contract. Compare them as contracts.
      const sameAsset = safeContract(terms.asset, network) === charge.currency;
      if (terms.amount !== charge.amount || terms.payTo !== charge.recipient || !sameAsset) {
        throw new TollwayError(
          "payment-failed",
          `the 402 from ${resource} asks for different terms over x402 and MPP charge; refusing to pick one`,
        );
      }
    } else {
      terms = { amount: charge.amount, asset: charge.currency, payTo: charge.recipient };
    }
    models.push("mpp-charge");
  }
  if (mpp.channelAmount !== undefined) {
    if (!terms) {
      throw new TollwayError(
        "payment-failed",
        `the 402 from ${resource} offers only an MPP channel, which names no payee or asset`,
      );
    }
    if (mpp.channelAmount !== terms.amount) {
      throw new TollwayError(
        "payment-failed",
        `the 402 from ${resource} asks for ${mpp.channelAmount} over an MPP channel and ${terms.amount} otherwise`,
      );
    }
    models.push("mpp-channel");
  }

  if (!terms) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} has no x402 or MPP challenge for Stellar ${network}`,
    );
  }
  return { resource, ...terms, network, models };
}

function safeContract(asset: string, network: StellarNetwork): string | undefined {
  try {
    return offerAssetContract(asset, network);
  } catch {
    // An asset that maps to no contract cannot equal MPP's currency; the
    // caller reports the mismatch.
    return undefined;
  }
}

/** The first Stellar `exact` option for `network`, or undefined when x402 is not offered for it. */
function readX402Terms(
  response: Response,
  resource: string,
  network: StellarNetwork,
): Terms | undefined {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!header) return undefined;
  let decoded: unknown;
  try {
    decoded = decodePaymentRequiredHeader(header);
  } catch (error) {
    throw new TollwayError(
      "payment-failed",
      `the ${PAYMENT_REQUIRED_HEADER} header from ${resource} is not valid x402: ${messageOf(error)}`,
    );
  }
  const parsed = paymentRequiredSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new TollwayError(
      "payment-failed",
      `the ${PAYMENT_REQUIRED_HEADER} header from ${resource} is not an x402 V2 challenge: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    );
  }
  const caip2 = MPP_NETWORK_ID[network];
  const option = parsed.data.accepts.find(
    (candidate) => candidate.scheme === "exact" && candidate.network === caip2,
  );
  return option ? { amount: option.amount, asset: option.asset, payTo: option.payTo } : undefined;
}

/**
 * The Stellar charge request and channel amount a 402 carries for `network`.
 * A `WWW-Authenticate` header that is not an MPP `Payment` challenge (a
 * Bearer realm, say) is not an MPP offer and is left alone.
 */
function readMppChallenges(
  response: Response,
  network: StellarNetwork,
): { charge?: z.infer<typeof chargeRequestSchema>; channelAmount?: string } {
  if (!response.headers.has("WWW-Authenticate")) return {};
  let challenges: Challenge.Challenge[];
  try {
    challenges = Challenge.fromResponseList(response);
  } catch {
    // Not a Payment challenge; nothing for the MPP models here.
    return {};
  }
  const result: { charge?: z.infer<typeof chargeRequestSchema>; channelAmount?: string } = {};
  for (const challenge of challenges) {
    if (challenge.method !== "stellar") continue;
    if (challenge.intent === "charge" && result.charge === undefined) {
      const parsed = chargeRequestSchema.safeParse(challenge.request);
      // The charge settler requires the network to be named, so a challenge
      // without it is not an offer this agent can pay.
      if (parsed.success && parsed.data.methodDetails?.network === MPP_NETWORK_ID[network]) {
        result.charge = parsed.data;
      }
    } else if (challenge.intent === "channel" && result.channelAmount === undefined) {
      const parsed = channelRequestSchema.safeParse(challenge.request);
      const named = parsed.success ? parsed.data.methodDetails?.network : undefined;
      if (parsed.success && named !== undefined && MPP_CHANNEL_NETWORK[network].includes(named)) {
        result.channelAmount = parsed.data.amount;
      }
    }
  }
  return result;
}
