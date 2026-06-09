/**
 * @tollway/client
 *
 * The agent-side wrapper. One call to pay for a resource; the client runs
 * the policy check, asks the router which model to use, signs the right
 * proof, and hands back a canonical receipt. See docs/design.md,
 * "Architecture" (agent side).
 */

import {
  type ModelRouter,
  NotImplementedError,
  type PaymentOffer,
  type PolicyEngine,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
} from "@tollway/core";

/** Events the client emits so callers and observability can follow along. */
export type ClientEvent =
  | { type: "payment"; resource: string; model: SettlementModel }
  | { type: "skip"; resource: string; reason: string }
  | { type: "error"; resource: string; error: Error }
  | { type: "budget:warning"; remaining: string }
  | { type: "channel:opened"; channelId: string }
  | { type: "channel:closed"; channelId: string };

export type ClientEventHandler = (event: ClientEvent) => void;

export type TollwayClientOptions = {
  network: StellarNetwork;
  router?: ModelRouter;
  policy?: PolicyEngine;
  /** Default facilitator when an offer does not name one. */
  facilitatorUrl?: string;
};

export type PayRequest = {
  /** The resource URL to pay for. */
  resource: string;
  /** A known offer, when the 402 challenge has already been read. */
  offer?: PaymentOffer;
  /** Force a settlement model, bypassing the router. */
  model?: SettlementModel;
};

export type PayResult = {
  receipt: SignedReceipt;
  model: SettlementModel;
};

export interface TollwayClient {
  pay(request: PayRequest): Promise<PayResult>;
  on(handler: ClientEventHandler): void;
}

/**
 * TODO: wire the agent-side x402 flow (read the 402 challenge, sign the
 * Soroban authorization via @x402/stellar, resubmit, record the receipt),
 * then add MPP charge and channel modes. The exact SDK calls are left out
 * until they are pinned. See docs/design.md, "Architecture".
 */
export function createClient(_options: TollwayClientOptions): TollwayClient {
  throw new NotImplementedError("the agent client", 'docs/design.md, "Architecture"');
}
