/**
 * Vercel AI SDK integration for Tollway (#208).
 *
 * Provides `createPaidFetchTool`, a `paid_fetch` tool compatible with the
 * Vercel AI SDK (`ai` package's `tool({ description, inputSchema, execute })`
 * and `generateText` / `streamText`).
 *
 * Model-driven callers choose URLs at runtime, so this integration pairs
 * Tollway's policy engine and offer checks with origin allowlists, method
 * allowlists, response size bounds, and structured policy-outcome results so
 * the model can reason about a blocked payment instead of crashing the run.
 */

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
import type { ClientStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { z } from "zod";
import {
  type ChannelFallbackOptions,
  type ClientEventHandler,
  type ClientSettler,
  createClient,
  PolicyBlockedError,
  type SettleRequest,
  type TollwayClient,
} from "./index.js";
import {
  type OfferChecks,
  OfferRejectedError,
  passesAllowlists,
  validateOfferChecks,
} from "./offer-checks.js";
import { messageOf, readReceiptHeader } from "./receipt-header.js";
import type { ReceiptStore } from "./receipt-store.js";
import { type RetryOptions, SettlementOutcomeError, type SignedTerms } from "./retry.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402-settler.js";

const CAIP2: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const DEFAULT_MAX_BODY_BYTES = 65_536;
const DEFAULT_ALLOWED_METHODS = ["GET", "POST"] as const;

export const paidFetchInputSchema = z.object({
  url: z.string().url().describe("The HTTP or HTTPS URL to fetch."),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
    .optional()
    .describe("HTTP method to use. Defaults to GET."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional HTTP request headers."),
  body: z.string().optional().describe("Optional HTTP request body for write methods."),
});

export type PaidFetchInput = z.infer<typeof paidFetchInputSchema>;

/** Execution context forwarded by Vercel AI SDK `generateText` / `streamText`. */
export type AiToolExecuteContext = {
  abortSignal?: AbortSignal;
  toolCallId?: string;
  messages?: unknown[];
};

export type CompactReceiptSummary = {
  id: string;
  model: SettlementModel;
  network: StellarNetwork;
  amount: string;
  asset: string;
  payee: string;
  txHash?: string;
  channelId?: string;
  issuedAt: string;
  deduplicated: boolean;
};

export type PaidFetchToolResult =
  | {
      ok: boolean;
      status: number;
      paid: false;
      body: string;
      truncated: boolean;
      contentType?: string;
    }
  | {
      ok: boolean;
      status: number;
      paid: true;
      body: string;
      truncated: boolean;
      contentType?: string;
      receipt: CompactReceiptSummary;
      storeError?: string;
    }
  | {
      ok: false;
      blocked: true;
      paid: false;
      reason: string;
      detail: string;
      errorCode?: string;
      rule?: string;
      checkName?: string;
    };

export type PaidFetchToolOptions = {
  network: StellarNetwork;
  signer?: ClientStellarSigner;
  /**
   * Optional custom payment signer. When omitted, uses `@x402/core` +
   * `ExactStellarScheme` with `signer`.
   */
  signPayment?: (input: {
    paymentRequired: PaymentRequired;
    requirements: PaymentRequirements;
    offer: PaymentOffer;
  }) => Promise<PaymentPayload>;
  rpcUrl?: string;
  /**
   * Origin allowlist (e.g. `["https://api.example.com"]`). When set, requests
   * to any other origin are blocked before any network call is made.
   */
  allowedOrigins?: readonly string[];
  /** HTTP methods the model is allowed to invoke. Defaults to `["GET", "POST"]`. */
  allowedMethods?: readonly string[];
  /** Maximum response body characters/bytes returned to the model. Defaults to 65536. */
  maxBodyBytes?: number;
  /** Human-readable budget summary surfaced in the tool description for the model. */
  budgetDisplay?: string;
  /** Optional custom tool description. */
  description?: string;
  fetch?: typeof globalThis.fetch;
  policy?: PolicyEngine;
  shadow?: PolicyEngine;
  logger?: { warn(message: string): void };
  router?: ModelRouter;
  offerChecks?: OfferChecks;
  quarantine?: CounterpartyQuarantine;
  verifier?: ReceiptVerifier;
  receiptMaxSkewMs?: number;
  clock?: () => number;
  receiptStore?: ReceiptStore;
  onStoreError?: (error: Error, receipt: SignedReceipt) => void;
  retry?: RetryOptions;
  fallback?: ChannelFallbackOptions;
  onEvent?: ClientEventHandler;
};

export type PaidFetchTool = {
  description: string;
  inputSchema: typeof paidFetchInputSchema;
  execute: (input: PaidFetchInput, context?: AiToolExecuteContext) => Promise<PaidFetchToolResult>;
  readonly tollway: TollwayClient;
};

type PendingHttpCall = {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  abortSignal?: AbortSignal;
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
  paidResponse?: Response;
};

/**
 * Creates a Vercel AI SDK compatible `paid_fetch` tool backed by Tollway.
 *
 * Returns `{ description, inputSchema, execute }` matching `ai`'s `tool()`
 * shape, plus `tollway` for direct client inspection or event subscription.
 */
export function createPaidFetchTool(options: PaidFetchToolOptions): PaidFetchTool {
  if (!options.signer && !options.signPayment) {
    throw new TypeError("createPaidFetchTool: either signer or signPayment is required");
  }
  if (options.offerChecks) {
    validateOfferChecks(options.offerChecks, options.network);
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError(`createPaidFetchTool: maxBodyBytes must be a positive integer`);
  }

  const normalizedOrigins = options.allowedOrigins
    ? new Set(options.allowedOrigins.map((origin) => new URL(origin).origin))
    : undefined;
  const allowedMethods = new Set(
    (options.allowedMethods ?? DEFAULT_ALLOWED_METHODS).map((m) => m.toUpperCase()),
  );
  const caip2Network = CAIP2[options.network];
  const doFetch = options.fetch ?? globalThis.fetch;
  const scheme = options.signer
    ? new ExactStellarScheme(
        options.signer,
        options.rpcUrl ? { url: options.rpcUrl } : undefined,
      )
    : undefined;

  const pendingCalls = new Map<string, PendingHttpCall>();

  const settler: ClientSettler = {
    ...(options.signer ? { payer: options.signer.address } : {}),
    async settle({ resource, offer, model, pinned }: SettleRequest): Promise<SignedReceipt> {
      if (model !== "x402") {
        throw new TollwayError("payment-failed", `paid_fetch cannot settle model "${model}"`);
      }
      const pending = pendingCalls.get(resource);
      if (!pending) {
        throw new TollwayError("payment-failed", `no pending request found for ${resource}`);
      }

      const { paymentRequired, requirements, method, headers, body, abortSignal } = pending;
      if (pinned) {
        assertMatchesPinned(requirements, pinned, resource);
      }
      const signedTerms: SignedTerms = {
        amount: requirements.amount,
        asset: requirements.asset,
        payTo: requirements.payTo,
      };

      let payload: PaymentPayload;
      if (options.signPayment) {
        payload = await options.signPayment({ paymentRequired, requirements, offer });
      } else {
        if (!scheme) {
          throw new TollwayError("payment-failed", "no x402 signer configured for paid_fetch");
        }
        const x402 = x402Client.fromConfig({
          schemes: [{ network: caip2Network, client: scheme }],
          spendControls: {
            allowedAssets: [
              {
                network: caip2Network,
                asset: requirements.asset,
                maxAmountPerPayment: offer.amount,
              },
            ],
          },
        });
        if (options.offerChecks) {
          x402.registerPolicy((_version, candidates) =>
            candidates.filter((option) => passesAllowlists(option, options.offerChecks)),
          );
        }
        x402.registerPolicy((_version, candidates) =>
          candidates.filter((option) => sameOption(option, requirements)),
        );
        try {
          payload = await x402.createPaymentPayload(paymentRequired);
        } catch (error) {
          throw new TollwayError(
            "payment-failed",
            `could not sign the x402 payment for ${resource}: ${messageOf(error)}`,
          );
        }
      }

      const paymentHeader = encodePaymentSignatureHeader(payload);

      const submit = async (): Promise<SignedReceipt> => {
        let paid: Response;
        try {
          paid = await doFetch(resource, {
            method,
            headers: {
              ...headers,
              [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
            },
            ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
            ...(abortSignal ? { signal: abortSignal } : {}),
          });
        } catch (networkError) {
          if (abortSignal?.aborted) throw networkError;
          throw new SettlementOutcomeError({
            kind: "ambiguous",
            reason: `the paid request to ${resource} failed after it was sent: ${messageOf(networkError)}`,
            cause: networkError,
          });
        }

        if (paid.status === 402) {
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
              reason: `${resource} answered the signed payment with 409 and no Retry-After`,
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

        pending.paidResponse = paid;
        return readReceiptHeader(paid, resource);
      };

      return submit();
    },
  };

  const tollway = createClient({
    network: options.network,
    settler,
    policy: options.policy,
    shadow: options.shadow,
    logger: options.logger,
    router: options.router,
    offerChecks: options.offerChecks,
    quarantine: options.quarantine,
    verifier: options.verifier,
    receiptMaxSkewMs: options.receiptMaxSkewMs,
    clock: options.clock,
    receiptStore: options.receiptStore,
    onStoreError: options.onStoreError,
    retry: options.retry,
    fallback: options.fallback,
  });

  if (options.onEvent) {
    tollway.on(options.onEvent);
  }

  const description = options.description ?? buildToolDescription(options, normalizedOrigins);

  return {
    description,
    inputSchema: paidFetchInputSchema,
    tollway,
    async execute(
      input: PaidFetchInput,
      context?: AiToolExecuteContext,
    ): Promise<PaidFetchToolResult> {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(input.url);
      } catch {
        return {
          ok: false,
          blocked: true,
          paid: false,
          reason: "invalid-url",
          detail: `invalid URL: ${input.url}`,
        };
      }

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return {
          ok: false,
          blocked: true,
          paid: false,
          reason: "unsupported-protocol",
          detail: `unsupported protocol "${parsedUrl.protocol}"; only http and https are allowed`,
        };
      }

      if (normalizedOrigins && !normalizedOrigins.has(parsedUrl.origin)) {
        return {
          ok: false,
          blocked: true,
          paid: false,
          reason: "origin-not-allowed",
          detail: `origin "${parsedUrl.origin}" is not in allowedOrigins`,
        };
      }

      const method = (input.method ?? "GET").toUpperCase();
      if (!allowedMethods.has(method)) {
        return {
          ok: false,
          blocked: true,
          paid: false,
          reason: "method-not-allowed",
          detail: `HTTP method "${method}" is not allowed`,
        };
      }

      const abortSignal = context?.abortSignal;
      const initial = await doFetch(input.url, {
        method,
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.body !== undefined && method !== "GET" && method !== "HEAD"
          ? { body: input.body }
          : {}),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      if (initial.status !== 402) {
        const { body, truncated } = await readBoundedBody(initial, maxBodyBytes);
        const contentType = initial.headers.get("content-type") ?? undefined;
        return {
          ok: initial.ok,
          status: initial.status,
          paid: false,
          body,
          truncated,
          ...(contentType ? { contentType } : {}),
        };
      }

      let paymentRequired: PaymentRequired;
      let requirements: PaymentRequirements;
      try {
        paymentRequired = readPaymentRequired(initial, input.url);
        requirements = selectRequirements(
          paymentRequired,
          caip2Network,
          input.url,
          options.offerChecks,
        );
      } catch (err) {
        const error = err instanceof TollwayError ? err : new TollwayError("payment-failed", messageOf(err));
        return {
          ok: false,
          blocked: true,
          paid: false,
          reason: error.code,
          detail: error.message,
          errorCode: error.code,
        };
      }

      const offer: PaymentOffer = {
        resource: input.url,
        amount: requirements.amount,
        asset: requirements.asset,
        payTo: requirements.payTo,
        network: options.network,
        models: ["x402"],
      };

      const pending: PendingHttpCall = {
        method,
        headers: input.headers,
        body: input.body,
        abortSignal,
        paymentRequired,
        requirements,
      };
      pendingCalls.set(input.url, pending);

      try {
        const payResult = await tollway.pay({
          resource: input.url,
          offer,
          model: "x402",
        });
        const paidResponse = pending.paidResponse;
        if (!paidResponse) {
          return {
            ok: false,
            blocked: true,
            paid: false,
            reason: "payment-failed",
            detail: `payment settled for ${input.url} without an HTTP response`,
          };
        }
        const { body, truncated } = await readBoundedBody(paidResponse, maxBodyBytes);
        const contentType = paidResponse.headers.get("content-type") ?? undefined;
        const settlement = payResult.receipt.receipt.settlement;
        return {
          ok: paidResponse.ok,
          status: paidResponse.status,
          paid: true,
          body,
          truncated,
          ...(contentType ? { contentType } : {}),
          receipt: {
            id: payResult.receipt.receipt.id,
            model: payResult.model,
            network: payResult.receipt.receipt.network,
            amount: payResult.receipt.receipt.amount,
            asset: payResult.receipt.receipt.asset,
            payee: payResult.receipt.receipt.payee,
            ...(settlement.kind === "transaction"
              ? { txHash: settlement.txHash }
              : { channelId: settlement.channelId }),
            issuedAt: payResult.receipt.receipt.issuedAt,
            deduplicated: payResult.deduplicated,
          },
          ...(payResult.storeError ? { storeError: payResult.storeError.message } : {}),
        };
      } catch (err) {
        if (abortSignal?.aborted) throw err;
        if (err instanceof PolicyBlockedError) {
          return {
            ok: false,
            blocked: true,
            paid: false,
            reason: "policy-blocked",
            detail: err.message,
            errorCode: err.code,
            rule: err.rule,
          };
        }
        if (err instanceof OfferRejectedError) {
          return {
            ok: false,
            blocked: true,
            paid: false,
            reason: "offer-rejected",
            detail: err.message,
            errorCode: err.code,
            checkName: err.checkName,
          };
        }
        if (err instanceof TollwayError) {
          return {
            ok: false,
            blocked: true,
            paid: false,
            reason: err.code,
            detail: err.message,
            errorCode: err.code,
          };
        }
        return {
          ok: false,
          blocked: true,
          paid: false,
          reason: "payment-failed",
          detail: messageOf(err),
        };
      } finally {
        pendingCalls.delete(input.url);
      }
    },
  };
}

function buildToolDescription(
  options: PaidFetchToolOptions,
  allowedOrigins: Set<string> | undefined,
): string {
  const parts = [
    `Fetch an HTTP/HTTPS URL on Stellar ${options.network}, automatically paying x402 402 challenges through Tollway policy and budget controls.`,
  ];
  if (allowedOrigins && allowedOrigins.size > 0) {
    parts.push(`Allowed origins: ${[...allowedOrigins].join(", ")}.`);
  }
  if (options.offerChecks?.maxAmount) {
    const limits = Object.entries(options.offerChecks.maxAmount)
      .map(([asset, limit]) => `${asset}: ${limit}`)
      .join(", ");
    parts.push(`Per-call price limits (base units): ${limits}.`);
  }
  if (options.budgetDisplay) {
    parts.push(`Budget: ${options.budgetDisplay}.`);
  }
  parts.push(
    "If a payment is blocked by policy or limits, a structured blocked result is returned so you can adjust or inform the user.",
  );
  return parts.join(" ");
}

async function readBoundedBody(
  response: Response,
  maxBodyBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const text = await response.text();
  if (text.length <= maxBodyBytes) {
    return { body: text, truncated: false };
  }
  return {
    body: text.slice(0, maxBodyBytes),
    truncated: true,
  };
}

function readPaymentRequired(response: Response, resource: string): PaymentRequired {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!header) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} has no ${PAYMENT_REQUIRED_HEADER} header`,
    );
  }
  let decoded: PaymentRequired;
  try {
    decoded = decodePaymentRequiredHeader(header);
  } catch (error) {
    throw new TollwayError(
      "payment-failed",
      `the ${PAYMENT_REQUIRED_HEADER} header from ${resource} is not valid x402: ${messageOf(error)}`,
    );
  }
  if (!Array.isArray(decoded?.accepts)) {
    throw new TollwayError(
      "payment-failed",
      `the ${PAYMENT_REQUIRED_HEADER} header from ${resource} lists no payment options`,
    );
  }
  return decoded;
}

function selectRequirements(
  paymentRequired: PaymentRequired,
  caip2Network: string,
  resource: string,
  offerChecks?: OfferChecks,
): PaymentRequirements {
  const match = paymentRequired.accepts.find(
    (option) =>
      option.scheme === "exact" &&
      option.network === caip2Network &&
      passesAllowlists(option, offerChecks),
  );
  if (!match) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} has no Stellar exact option for ${caip2Network}${offerChecks ? " within the offer-check allowlists" : ""}`,
    );
  }
  return match;
}

function assertMatchesPinned(
  requirements: PaymentRequirements,
  pinned: SignedTerms,
  resource: string,
): void {
  const changed = (["amount", "asset", "payTo"] as const).filter(
    (field) => requirements[field] !== pinned[field],
  );
  if (changed.length > 0) {
    throw new SettlementOutcomeError({
      kind: "fatal",
      reason: `the offer from ${resource} changed between attempts (${changed.join(", ")}); not signing again`,
    });
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  const value = header?.trim();
  if (value === undefined || !/^[0-9]{1,6}$/.test(value)) return undefined;
  return Number(value) * 1000;
}

function sameOption(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.asset === b.asset &&
    a.payTo === b.payTo
  );
}
