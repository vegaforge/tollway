/**
 * MPP charge settler (#185): pays an MPP charge route on Stellar and returns the
 * Tollway receipt the service sends back.
 *
 * It checks the challenge against the approved offer before any credential is
 * created. A mismatch rejects and nothing is signed.
 *
 * NOTE: this module imports `@stellar/mpp` and `mppx`, which are not yet
 * declared in packages/client/package.json. The lockfile has not been
 * regenerated, so this module does not compile until those dependencies are
 * added. The mppx import paths below follow the issue text and have not been
 * checked against the installed packages.
 */

import { type SignedReceipt, TollwayError, signedReceiptSchema } from "@vegaforge/tollway-core";
import { stellar } from "@stellar/mpp/charge/client";
import { Mppx, Receipt } from "mppx/client";
import type { ClientSettler, SettleRequest } from "./index.js";
import { TOLLWAY_RECEIPT_HEADER } from "./x402-settler.js";

export type MppChargeSettlerOptions = {
  /** Either a keypair or a secret key. The settler never stores it. */
  keypair?: unknown;
  secretKey?: string;
  network: "testnet" | "mainnet";
  rpcUrl?: string;
  /** "pull" (default): the service submits. "push": the agent broadcasts and pays the fee. */
  mode?: "pull" | "push";
  decimals?: number;
  fetch?: typeof globalThis.fetch;
  receiptHeader?: string;
};

const CAIP2 = { testnet: "stellar:testnet", mainnet: "stellar:pubnet" } as const;
const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;

export function createMppChargeSettler(options: MppChargeSettlerOptions): ClientSettler {
  const network = CAIP2[options.network];
  const receiptHeader = options.receiptHeader ?? TOLLWAY_RECEIPT_HEADER;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async settle({ resource, offer, model }: SettleRequest): Promise<SignedReceipt> {
      if (model !== "mpp-charge") {
        throw new TollwayError("payment-failed", `the MPP charge settler cannot settle model "${model}"`);
      }
      if (!CONTRACT_ADDRESS.test(offer.asset)) {
        throw new TollwayError(
          "payment-failed",
          `offer asset ${offer.asset} is not a Soroban contract address; MPP charge needs one`,
        );
      }

      let challengeSeen = false;
      const method = stellar.charge({
        ...(options.keypair ? { keypair: options.keypair } : { secretKey: options.secretKey }),
        decimals: options.decimals,
        rpcUrl: options.rpcUrl,
        mode: options.mode ?? "pull",
      } as Parameters<typeof stellar.charge>[0]);

      const mppx = Mppx.create({
        methods: [method],
        fetch: doFetch,
        polyfill: false,
        onChallenge: async (challenge: any, { createCredential }: any) => {
          challengeSeen = true;
          assertChallengeMatchesOffer(challenge, offer, network, resource);
          return createCredential();
        },
      });

      const response = await mppx.fetch(resource);
      if (!challengeSeen) {
        throw new TollwayError(
          "payment-failed",
          `${resource} did not answer with an MPP charge challenge (got ${response.status})`,
        );
      }
      if (!response.ok) {
        throw new TollwayError("payment-failed", `${resource} answered the payment with ${response.status}`);
      }

      const receipt = readTollwayReceipt(response, receiptHeader, resource);
      if (receipt.model !== "mpp-charge") {
        throw new TollwayError("invalid-receipt", `receipt model is "${receipt.model}", expected mpp-charge`);
      }

      let mppReceipt: { reference?: string } | undefined;
      try {
        mppReceipt = Receipt.fromResponse(response) as { reference?: string };
      } catch {
        mppReceipt = undefined;
      }
      if (mppReceipt?.reference !== undefined) {
        if (receipt.settlement.kind !== "transaction" || receipt.settlement.txHash !== mppReceipt.reference) {
          throw new TollwayError(
            "invalid-receipt",
            "the Tollway receipt's settlement does not match the MPP receipt reference",
          );
        }
      }
      return receipt;
    },
  };
}

function assertChallengeMatchesOffer(
  challenge: any,
  offer: SettleRequest["offer"],
  network: string,
  resource: string,
): void {
  const fail = (message: string): never => {
    throw new TollwayError("payment-failed", `${resource}: ${message}; nothing was signed`);
  };
  if (challenge?.method !== "stellar") fail(`challenge method is ${challenge?.method}, not stellar`);
  if (challenge?.intent !== "charge") fail(`challenge intent is ${challenge?.intent}, not charge`);
  const request = challenge?.request ?? {};
  if (request.amount !== offer.amount) fail(`challenge asks for ${request.amount}, offer is ${offer.amount}`);
  if (request.recipient !== offer.payTo) fail(`challenge pays ${request.recipient}, offer payee is ${offer.payTo}`);
  if (request.currency !== offer.asset) fail(`challenge charges ${request.currency}, offer asset is ${offer.asset}`);
  const challengeNetwork = request.methodDetails?.network;
  if (challengeNetwork !== network) fail(`challenge network is ${challengeNetwork}, expected ${network}`);
}

function readTollwayReceipt(response: Response, header: string, resource: string): SignedReceipt {
  const value = response.headers.get(header);
  if (!value) {
    throw new TollwayError("invalid-receipt", `${resource} sent no ${header} header`);
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(Buffer.from(value, "base64")));
  } catch {
    throw new TollwayError("invalid-receipt", `the ${header} header from ${resource} is not base64 JSON`);
  }
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError("invalid-receipt", `the ${header} header from ${resource} is not a Tollway receipt`);
  }
  return parsed.data;
}
