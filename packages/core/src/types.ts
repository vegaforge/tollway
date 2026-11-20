/**
 * Shared domain types. Fields owned by an upstream SDK (@x402/stellar,
 * @stellar/mpp) are left opaque rather than guessed at.
 */

import type { PaymentPayload as X402PaymentPayload } from "@x402/core/types";

/** The three ways a payment can settle. See docs/design.md, "The model router". */
export const settlementModels = ["x402", "mpp-charge", "mpp-channel"] as const;

/** One of the three settlement models: x402, MPP charge, or MPP channel. */
export type SettlementModel = (typeof settlementModels)[number];

/**
 * The Stellar networks Tollway settles on, by Tollway's own names. The x402
 * path maps them to the CAIP-2 ids `stellar:testnet` and `stellar:pubnet`.
 */
export const stellarNetworks = ["testnet", "mainnet"] as const;

/** A Stellar network Tollway settles on: `testnet` or `mainnet`. */
export type StellarNetwork = (typeof stellarNetworks)[number];

/**
 * What a service declares about a paid resource. This is Tollway's view of
 * the 402 challenge, with the routing hints the model router reads.
 */
export type PaymentOffer = {
  /** URL or stable identifier of the thing being sold. */
  resource: string;
  /** Price as an integer string in the asset's smallest unit. */
  amount: string;
  /**
   * Asset identifier. For x402 this is the Soroban asset contract address
   * (`C...`, for example the USDC Sac), which is what `PaymentRequirements.asset`
   * carries; the MPP settlement models may use another identifier.
   */
  asset: string;
  /** Stellar address the payment settles to. Tollway never sits in between. */
  payTo: string;
  network: StellarNetwork;
  /** Settlement models the service accepts, in its order of preference. */
  models: SettlementModel[];
  /** Routing hint from the offer; see docs/design.md, "The model router". */
  mppSessionSupported?: boolean;
  /** Base URL of the facilitator the service settles through. */
  facilitatorUrl?: string;
};

/**
 * Proof of payment as submitted by an agent, one variant per model.
 */
export type X402Payment = {
  model: "x402";
  /**
   * The decoded `PaymentPayload` from the PAYMENT-SIGNATURE header, in the x402
   * V2 shape: `accepted` (the requirement it pays) and `payload.transaction`,
   * the base64 Stellar transaction envelope with the signed Soroban
   * authorization entry. Validated at the server boundary; @x402/stellar owns
   * the inner format.
   */
  payload: X402PaymentPayload;
};

/** An MPP charge: a single payment authorized by an MPP credential. */
export type MppChargePayment = {
  model: "mpp-charge";
  /**
   * The agent's MPP credential from the `Authorization` header, exactly as
   * sent: the `Payment <base64url JSON>` scheme `mppx` serializes. It holds
   * the challenge being answered, the payer (`source`, a `did:pkh` id) and
   * the signed transfer. Opaque to Tollway; `mppx` and @stellar/mpp own the
   * format.
   */
  payload: string;
};

/**
 * One commitment in an MPP payment channel. The agent funds the channel once
 * and then signs a growing cumulative total for each payment.
 */
export type MppChannelPayment = {
  model: "mpp-channel";
  channelId: string;
  /** Position in the channel's cumulative commitment stream. */
  sequence: number;
  /** Total committed so far, as an integer string. Cumulative, not a delta. */
  cumulativeAmount: string;
  /** TODO: the funder-signed commitment, in @stellar/mpp's encoding. */
  commitment: string;
};

/** The payment an agent submits, whichever model it settles through. Narrow on `model`. */
export type PaymentPayload = X402Payment | MppChargePayment | MppChannelPayment;
