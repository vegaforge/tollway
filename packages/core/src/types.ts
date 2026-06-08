/**
 * Shared domain types. Fields owned by an upstream SDK (@x402/stellar,
 * @stellar/mpp) are left opaque rather than guessed at.
 */

/** The three ways a payment can settle. See docs/design.md, "The model router". */
export const settlementModels = ["x402", "mpp-charge", "mpp-channel"] as const;

export type SettlementModel = (typeof settlementModels)[number];

export const stellarNetworks = ["testnet", "mainnet"] as const;

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
  /** Asset identifier, for example "USDC:GA5Z...". */
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
   * Contents of the PAYMENT-SIGNATURE header: the signed Soroban
   * authorization entry. Opaque to Tollway; @x402/stellar owns the format.
   */
  paymentSignature: string;
};

export type MppChargePayment = {
  model: "mpp-charge";
  /** TODO: the real charge proof, once @stellar/mpp's charge shape is wired in. */
  payload: string;
};

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

export type PaymentPayload = X402Payment | MppChargePayment | MppChannelPayment;
