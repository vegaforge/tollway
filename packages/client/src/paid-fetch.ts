/**
 * Drop-in `fetch` wrapper that handles x402 V2 and MPP 402 challenges (#201).
 *
 * One call to pay for a resource: sends the request once, and on a 402 parses
 * the challenge (`PAYMENT-REQUIRED` for x402 V2, `WWW-Authenticate: Payment`
 * for MPP), runs the client's offer checks, policy engine, and model router,
 * signs the payment with the configured `AgentSigner`, replays the original
 * request (preserving method, headers, and body) with the payment header,
 * verifies the returned Tollway receipt, and returns the paid `Response`
 * together with `receipt` and `model`.
 *
 * See docs/design.md, "Architecture" (agent side) and "The model router".
 */

import { stellar } from "@stellar/mpp/charge/client";
import {
  type CounterpartyQuarantine,
  type ModelRouter,
  type PaymentOffer,
  type PolicyEngine,
  type ReceiptVerifier,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  TollwayError,
} from "@vegaforge/tollway-core";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Challenge, Receipt as MppReceipt } from "mppx";
import { Mppx } from "mppx/client";
import { z } from "zod";
import {
  type ClientEventHandler,
  type ClientSettler,
  createClient,
  type SettleRequest,
  type TollwayClient,
} from "./index.js";
import { type MppChargeMode, MPP_NETWORK_ID, offerAssetContract } from "./mpp-charge-settler.js";
import { type OfferChecks, passesAllowlists, validateOfferChecks } from "./offer-checks.js";
import { messageOf, readReceiptHeader, TOLLWAY_RECEIPT_HEADER } from "./receipt-header.js";
import type { ReceiptStore } from "./receipt-store.js";
import { type RetryOptions, SettlementOutcomeError, type SignedTerms } from "./retry.js";
import { type AgentSigner, assertKeypairSigner } from "./signer.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402-settler.js";

const CAIP2: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const chargeRequestSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  recipient: z.string(),
  methodDetails: z.object({ network: z.string() }).optional(),
});

/** A `Response` augmented with the verified Tollway receipt when a 402 was paid. */
export type PaidResponse = Response & {
  receipt?: SignedReceipt;
  model?: SettlementModel;
};

/** Callable `fetch` function returned by {@link createPaidFetch}. */
export type PaidFetch = {
  (input: RequestInfo | URL, init?: RequestInit): Promise<PaidResponse>;
  /** Underlying Tollway client for inspecting events or policy state. */
  readonly client: TollwayClient;
};

export type PaidFetchOptions = {
  network: StellarNetwork;
  /** Agent identity used to sign payments. */
  signer: AgentSigner;
  /** Underlying `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  policy?: PolicyEngine;
  shadow?: PolicyEngine;
  router?: ModelRouter;
  offerChecks?: OfferChecks;
  quarantine?: CounterpartyQuarantine;
  verifier?: ReceiptVerifier;
  receiptMaxSkewMs?: number;
  clock?: () => number;
  receiptStore?: ReceiptStore;
  onStoreError?: (error: Error, receipt: SignedReceipt) => void;
  retry?: RetryOptions;
  logger?: { warn(message: string): void };
  /** Soroban RPC URL for x402 simulations and MPP charge. */
  rpcUrl?: string;
  /** MPP charge mode. Defaults to `"pull"`. */
  mppMode?: MppChargeMode;
  /** Header carrying the signed Tollway receipt. Defaults to `TOLLWAY-RECEIPT`. */
  receiptHeader?: string;
  /** Optional event handler registered on the underlying Tollway client. */
  onEvent?: ClientEventHandler;
};

type CapturedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
};

async function captureRequest(input: RequestInfo | URL, init?: RequestInit): Promise<CapturedRequest> {
  if (input instanceof Request) {
    const cloned = input.clone();
    const headers = new Headers(input.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    const method = (init?.method ?? input.method ?? "GET").toUpperCase();
    let body: BodyInit | null | undefined = init?.body;
    if (body === undefined && method !== "GET" && method !== "HEAD" && input.body !== null) {
      body = await cloned.arrayBuffer();
    }
    return { url: input.url, method, headers, body };
  }
  const url = input instanceof URL ? input.toString() : input;
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  return { url, method, headers, body: init?.body };
}

function buildReplayInit(captured: CapturedRequest, extraHeader: [string, string]): RequestInit {
  const headers = new Headers(captured.headers);
  headers.set(extraHeader[0], extraHeader[1]);
  return {
    method: captured.method,
    headers,
    ...(captured.body !== undefined && captured.body !== null ? { body: captured.body } : {}),
  };
}

type ParsedChallenge = {
  offer: PaymentOffer;
  x402?: { paymentRequired: PaymentRequired; requirements: PaymentRequirements };
  mppCharge?: { challenge: Challenge.Challenge; amount: string; currency: string; recipient: string };
};

function parse402Challenge(
  response: Response,
  url: string,
  network: StellarNetwork,
  offerChecks?: OfferChecks,
): ParsedChallenge {
  const caip2 = CAIP2[network];
  const models: SettlementModel[] = [];
  let x402Match: ParsedChallenge["x402"];
  let mppMatch: ParsedChallenge["mppCharge"];

  const paymentRequiredHeader = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (paymentRequiredHeader) {
    let decoded: PaymentRequired;
    try {
      decoded = decodePaymentRequiredHeader(paymentRequiredHeader);
    } catch (error) {
      throw new TollwayError(
        "payment-failed",
        `the ${PAYMENT_REQUIRED_HEADER} header from ${url} is not valid x402: ${messageOf(error)}`,
      );
    }
    const requirements = decoded.accepts.find(
      (option) =>
        option.scheme === "exact" &&
        option.network === caip2 &&
        passesAllowlists(option, offerChecks),
    );
    if (requirements) {
      x402Match = { paymentRequired: decoded, requirements };
      models.push("x402");
    }
  }

  const wwwAuth = response.headers.get("www-authenticate");
  if (wwwAuth) {
    try {
      const challenges = Challenge.fromResponseList(response);
      for (const candidate of challenges) {
        if (candidate.method !== "stellar" || candidate.intent !== "charge") continue;
        const parsed = chargeRequestSchema.safeParse(candidate.request);
        if (!parsed.success) continue;
        const reqNetwork = parsed.data.methodDetails?.network;
        if (reqNetwork !== undefined && reqNetwork !== caip2) continue;
        mppMatch = {
          challenge: candidate,
          amount: parsed.data.amount,
          currency: parsed.data.currency,
          recipient: parsed.data.recipient,
        };
        models.push("mpp-charge");
        break;
      }
    } catch {
      // Ignore non-MPP WWW-Authenticate headers when x402 is present.
    }
  }

  if (models.length === 0) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${url} has no supported Stellar x402 or MPP challenge for ${network}`,
    );
  }

  const offer: PaymentOffer = x402Match
    ? {
        resource: url,
        amount: x402Match.requirements.amount,
        asset: x402Match.requirements.asset,
        payTo: x402Match.requirements.payTo,
        network,
        models,
      }
    : {
        resource: url,
        amount: (mppMatch as NonNullable<typeof mppMatch>).amount,
        asset: (mppMatch as NonNullable<typeof mppMatch>).currency,
        payTo: (mppMatch as NonNullable<typeof mppMatch>).recipient,
        network,
        models,
      };

  return { offer, x402: x402Match, mppCharge: mppMatch };
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

/**
 * Creates a drop-in `fetch` function that automatically handles 402 Payment
 * Required challenges for x402 V2 and MPP charge using Tollway's policy
 * engine, model router, receipt verification, and `AgentSigner`.
 */
export function createPaidFetch(options: PaidFetchOptions): PaidFetch {
  const doFetch = options.fetch ?? globalThis.fetch;
  const { network, signer } = options;
  if (signer.network !== network) {
    throw new TollwayError(
      "payment-failed",
      `paidFetch is configured for ${network}, but the signer is on ${signer.network}`,
    );
  }
  if (options.offerChecks) validateOfferChecks(options.offerChecks, network);

  const caip2 = CAIP2[network];
  const receiptHeader = options.receiptHeader ?? TOLLWAY_RECEIPT_HEADER;
  const x402Scheme = new ExactStellarScheme(
    signer.x402,
    options.rpcUrl ? { url: options.rpcUrl } : undefined,
  );

  // Per-call state keyed by an invocation token passed through SettleRequest
  // via a WeakMap-free per-call closure using a lightweight per-request map.
  type PendingContext = {
    captured: CapturedRequest;
    challengeResponse: Response;
    parsed: ParsedChallenge;
    paidResponse?: Response;
    refs: number;
  };
  const pendingByResource = new Map<string, PendingContext>();

  const settler: ClientSettler = {
    payer: signer.address,
    async settle({ resource, offer, model, pinned }: SettleRequest): Promise<SignedReceipt> {
      const ctx = pendingByResource.get(resource);
      if (!ctx) {
        throw new TollwayError("payment-failed", `no active 402 context for ${resource}`);
      }

      if (model === "x402") {
        let current402 = ctx.challengeResponse;
        let parsedChallenge = ctx.parsed;
        if (!parsedChallenge.x402) {
          parsedChallenge = parse402Challenge(current402, resource, network, options.offerChecks);
        }
        const x402Data = parsedChallenge.x402;
        if (!x402Data) {
          throw new TollwayError("payment-failed", `no x402 option in 402 from ${resource}`);
        }
        const { paymentRequired, requirements } = x402Data;
        if (
          requirements.amount !== offer.amount ||
          requirements.asset !== offer.asset ||
          requirements.payTo !== offer.payTo
        ) {
          throw new TollwayError(
            "payment-failed",
            `x402 challenge from ${resource} changed terms after policy approval`,
          );
        }
        if (
          pinned &&
          (requirements.amount !== pinned.amount ||
            requirements.asset !== pinned.asset ||
            requirements.payTo !== pinned.payTo)
        ) {
          throw new TollwayError(
            "payment-failed",
            `x402 retry challenge from ${resource} changed pinned terms`,
          );
        }
        const signedTerms: SignedTerms = {
          amount: requirements.amount,
          asset: requirements.asset,
          payTo: requirements.payTo,
        };

        const x402 = x402Client.fromConfig({
          schemes: [{ network: caip2, client: x402Scheme }],
          spendControls: {
            allowedAssets: [{ network: caip2, asset: requirements.asset, maxAmountPerPayment: offer.amount }],
          },
        });
        if (options.offerChecks) {
          const checks = options.offerChecks;
          x402.registerPolicy((_v, candidates) =>
            candidates.filter((option) => passesAllowlists(option, checks)),
          );
        }
        x402.registerPolicy((_v, candidates) =>
          candidates.filter(
            (option) =>
              option.scheme === requirements.scheme &&
              option.network === requirements.network &&
              option.asset === requirements.asset &&
              option.amount === requirements.amount &&
              option.payTo === requirements.payTo,
          ),
        );

        let payload: PaymentPayload;
        try {
          payload = await x402.createPaymentPayload(paymentRequired);
        } catch (error) {
          throw new TollwayError(
            "payment-failed",
            `could not sign x402 payment for ${resource}: ${messageOf(error)}`,
          );
        }
        const paymentHeader = encodePaymentSignatureHeader(payload);

        const submit = async (): Promise<SignedReceipt> => {
          let paid: Response;
          try {
            paid = await doFetch(
              ctx.captured.url,
              buildReplayInit(ctx.captured, [PAYMENT_SIGNATURE_HEADER, paymentHeader]),
            );
          } catch (networkError) {
            throw new SettlementOutcomeError({
              kind: "ambiguous",
              reason: `paid request to ${resource} failed after sending: ${messageOf(networkError)}`,
              cause: networkError,
            });
          }
          if (paid.status === 402) {
            current402 = paid;
            ctx.challengeResponse = paid;
            ctx.parsed = parse402Challenge(paid, resource, network, options.offerChecks);
            throw new SettlementOutcomeError({
              kind: "retryable-with-fresh-auth",
              reason: `${resource} answered the signed payment with another 402`,
              signedTerms,
            });
          }
          if (paid.status === 409) {
            const retryAfterMs = parseRetryAfterMs(paid.headers.get("retry-after"));
            if (retryAfterMs === undefined) {
              throw new SettlementOutcomeError({
                kind: "ambiguous",
                reason: `${resource} answered 409 without Retry-After; payment may have settled`,
              });
            }
            throw new SettlementOutcomeError({
              kind: "settlement-in-progress",
              reason: `${resource} is already settling this payment`,
              retryAfterMs,
              resend: submit,
            });
          }
          if (paid.status >= 500) {
            throw new SettlementOutcomeError({
              kind: "ambiguous",
              reason: `${resource} answered the signed payment with ${paid.status}`,
            });
          }
          if (!paid.ok) {
            throw new SettlementOutcomeError({
              kind: "fatal",
              reason: `${resource} answered the signed payment with ${paid.status}`,
            });
          }
          ctx.paidResponse = paid;
          return readReceiptHeader(paid, resource, receiptHeader);
        };

        return submit();
      }

      if (model === "mpp-charge") {
        const kpSigner = assertKeypairSigner(signer, "mpp-charge");
        const mppData = ctx.parsed.mppCharge;
        if (!mppData) {
          throw new TollwayError("payment-failed", `no MPP charge challenge in 402 from ${resource}`);
        }
        const expectedCurrency = offerAssetContract(offer.asset, network);
        const expectedNetworkId = MPP_NETWORK_ID[network];
        if (
          mppData.amount !== offer.amount ||
          mppData.currency !== expectedCurrency ||
          mppData.recipient !== offer.payTo ||
          (mppData.challenge.request as { methodDetails?: { network?: string } }).methodDetails
            ?.network !== expectedNetworkId
        ) {
          throw new TollwayError(
            "payment-failed",
            `MPP challenge from ${resource} does not match approved offer`,
          );
        }

        const chargeMethod = stellar.charge({
          keypair: kpSigner.keypair,
          decimals: 0,
          ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
          mode: options.mppMode ?? "pull",
        });
        const mppx = Mppx.create({ methods: [chargeMethod], fetch: doFetch, polyfill: false });

        let credential: string;
        try {
          credential = await mppx.createCredential(ctx.challengeResponse, undefined, {
            orderChallenges: (candidates) =>
              candidates.filter((c) => c.challenge.id === mppData.challenge.id),
          });
        } catch (error) {
          throw new TollwayError(
            "payment-failed",
            `could not create MPP charge credential for ${resource}: ${messageOf(error)}`,
          );
        }

        const paid = await doFetch(
          ctx.captured.url,
          buildReplayInit(ctx.captured, ["Authorization", credential]),
        );
        if (paid.status === 402) {
          throw new TollwayError(
            "payment-failed",
            `${resource} answered the MPP credential with another 402`,
          );
        }
        if (!paid.ok) {
          throw new TollwayError(
            "payment-failed",
            `${resource} answered the MPP credential with ${paid.status}`,
          );
        }

        const receipt = readReceiptHeader(paid, resource, receiptHeader);
        const mppHeader = paid.headers.get("payment-receipt");
        if (mppHeader) {
          let mppRef: string;
          try {
            mppRef = MppReceipt.deserialize(mppHeader).reference;
          } catch (error) {
            throw new TollwayError(
              "payment-failed",
              `Payment-Receipt header from ${resource} is invalid: ${messageOf(error)}`,
            );
          }
          if (
            receipt.settlement.kind === "tx" &&
            mppRef !== receipt.settlement.txHash
          ) {
            throw new TollwayError(
              "payment-failed",
              `Payment-Receipt reference (${mppRef}) disagrees with Tollway receipt txHash (${receipt.settlement.txHash})`,
            );
          }
        }
        ctx.paidResponse = paid;
        return receipt;
      }

      throw new TollwayError(
        "payment-failed",
        `createPaidFetch does not support settlement model "${model}"`,
      );
    },
  };

  const client = createClient({
    network,
    settler,
    policy: options.policy,
    shadow: options.shadow,
    router: options.router,
    offerChecks: options.offerChecks,
    quarantine: options.quarantine,
    verifier: options.verifier,
    receiptMaxSkewMs: options.receiptMaxSkewMs,
    clock: options.clock,
    receiptStore: options.receiptStore,
    onStoreError: options.onStoreError,
    retry: options.retry,
    logger: options.logger,
  });

  if (options.onEvent) {
    client.on(options.onEvent);
  }

  const paidFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<PaidResponse> => {
    const captured = await captureRequest(input, init);
    const first = await doFetch(captured.url, {
      method: captured.method,
      headers: captured.headers,
      ...(captured.body !== undefined && captured.body !== null ? { body: captured.body } : {}),
    });
    if (first.status !== 402) {
      return first;
    }

    const parsed = parse402Challenge(first, captured.url, network, options.offerChecks);
    const existing = pendingByResource.get(captured.url);
    const ctx: PendingContext = existing ?? {
      captured,
      challengeResponse: first,
      parsed,
      refs: 0,
    };
    ctx.refs += 1;
    pendingByResource.set(captured.url, ctx);
    try {
      const result = await client.pay({
        resource: captured.url,
        offer: parsed.offer,
      });
      const paid = ctx.paidResponse;
      if (!paid) {
        throw new TollwayError(
          "payment-failed",
          `payment settled for ${captured.url} without a paid HTTP response`,
        );
      }
      const response = result.deduplicated ? paid.clone() : paid;
      return Object.assign(response, {
        receipt: result.receipt,
        model: result.model,
      });
    } finally {
      ctx.refs -= 1;
      if (ctx.refs <= 0) {
        pendingByResource.delete(captured.url);
      }
    }
  }) as PaidFetch;

  Object.defineProperty(paidFetch, "client", {
    value: client,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  return paidFetch;
}
