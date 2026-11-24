/**
 * MCP client integration for Tollway (#207).
 *
 * Wraps an MCP client's `callTool` so x402 payment-required responses
 * (`isError: true` with `PaymentRequired`) are routed through `createClient`:
 * offer sanity checks, counterparty quarantine, policy budgets/caps/rate-limits,
 * receipt signature verification, receipt-to-offer binding, and receipt storage.
 *
 * Wire format (x402 MCP transport, specs/transports-v2/mcp.md):
 * - Server responds with `isError: true` and `PaymentRequired` in
 *   `structuredContent` (or JSON text content / `_meta["x402/payment-required"]`).
 * - Client retries `callTool` with `_meta["x402/payment"]` carrying the signed
 *   `PaymentPayload`.
 * - Server returns the tool result with `_meta["tollway/receipt"]` (configurable)
 *   carrying the signed Tollway receipt (and `_meta["x402/payment-response"]`).
 */

import {
  base64UrlToBytes,
  type CounterpartyQuarantine,
  type ModelRouter,
  type PaymentOffer,
  type PolicyEngine,
  type ReceiptVerifier,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  signedReceiptSchema,
  TollwayError,
} from "@vegaforge/tollway-core";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import {
  type ClientEventHandler,
  type ClientSettler,
  createClient,
  type SettleRequest,
  type TollwayClient,
} from "./index.js";
import { type OfferChecks, passesAllowlists, validateOfferChecks } from "./offer-checks.js";
import type { ReceiptStore } from "./receipt-store.js";
import { type RetryOptions, SettlementOutcomeError, type SignedTerms } from "./retry.js";

/** MCP `_meta` key carrying the x402 payment payload on retry. */
export const X402_MCP_PAYMENT_META_KEY = "x402/payment";
/** MCP `_meta` key carrying the x402 settlement response. */
export const X402_MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";
/** MCP `_meta` key carrying the signed Tollway receipt (#206). */
export const TOLLWAY_MCP_RECEIPT_META_KEY = "tollway/receipt";

const CAIP2: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

export type McpContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type McpToolResult = {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type McpCallToolParams = {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export interface McpClientLike {
  callTool(params: McpCallToolParams, ...args: unknown[]): Promise<McpToolResult>;
}

export type McpPaymentSignInput = {
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
  offer: PaymentOffer;
};

export type TollwayMcpClientOptions = {
  /** Underlying MCP client whose `callTool` will be wrapped. */
  client: McpClientLike;
  network: StellarNetwork;
  /**
   * Signs the x402 Soroban auth entry. Required unless `signPayment` is
   * provided.
   */
  signer?: ClientStellarSigner;
  /**
   * Optional custom payment signer. When omitted, uses `@x402/core` +
   * `ExactStellarScheme` with `signer`.
   */
  signPayment?: (input: McpPaymentSignInput) => Promise<PaymentPayload>;
  /** Soroban RPC URL for x402 simulations. Defaults to the public one. */
  rpcUrl?: string;
  /**
   * `_meta` key where the server places the signed Tollway receipt.
   * Defaults to `"tollway/receipt"`.
   */
  receiptMetaKey?: string;
  /**
   * Prefix used to construct a resource URI when `PaymentRequired.resource?.url`
   * is absent. Defaults to `"mcp://tools"`.
   */
  resourcePrefix?: string;
  /**
   * Optional approval hook mirroring `@x402/mcp`'s `onPaymentRequested`.
   * Runs before `tollway.pay()`; returning `false` denies the payment.
   */
  onPaymentRequested?: (context: {
    toolName: string;
    paymentRequired: PaymentRequired;
    offer: PaymentOffer;
  }) => boolean | Promise<boolean>;
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
};

export type TollwayMcpCallResult = {
  result: McpToolResult;
  paid: boolean;
  receipt?: SignedReceipt;
  model?: SettlementModel;
  deduplicated?: boolean;
  storeError?: Error;
};

export interface TollwayMcpClient {
  callTool(params: McpCallToolParams, ...args: unknown[]): Promise<TollwayMcpCallResult>;
  on(handler: ClientEventHandler): void;
  readonly tollway: TollwayClient;
}

type PendingMcpCall = {
  params: McpCallToolParams;
  args: unknown[];
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
  settledResult?: McpToolResult;
};

/**
 * Wraps an MCP client so paid tool calls are gated by Tollway's policy engine,
 * offer checks, quarantine, receipt verification, and receipt store.
 */
export function createTollwayMcpClient(options: TollwayMcpClientOptions): TollwayMcpClient {
  if (!options.signer && !options.signPayment) {
    throw new TypeError("createTollwayMcpClient: either signer or signPayment is required");
  }
  if (options.offerChecks) {
    validateOfferChecks(options.offerChecks, options.network);
  }

  const caip2Network = CAIP2[options.network];
  const receiptMetaKey = options.receiptMetaKey ?? TOLLWAY_MCP_RECEIPT_META_KEY;
  const resourcePrefix = (options.resourcePrefix ?? "mcp://tools").replace(/\/+$/, "");
  const scheme = options.signer
    ? new ExactStellarScheme(
        options.signer,
        options.rpcUrl ? { url: options.rpcUrl } : undefined,
      )
    : undefined;

  const pendingCalls = new Map<string, PendingMcpCall>();

  const settler: ClientSettler = {
    ...(options.signer ? { payer: options.signer.address } : {}),
    async settle({ resource, offer, model, pinned }: SettleRequest): Promise<SignedReceipt> {
      if (model !== "x402") {
        throw new TollwayError(
          "payment-failed",
          `the MCP settler cannot settle model "${model}"`,
        );
      }
      const pending = pendingCalls.get(resource);
      if (!pending) {
        throw new TollwayError(
          "payment-failed",
          `no pending MCP tool call found for resource ${resource}`,
        );
      }

      const { paymentRequired, requirements, params, args } = pending;
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
          throw new TollwayError("payment-failed", "no x402 signer configured for MCP payment");
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
            `could not sign the x402 MCP payment for ${resource}: ${messageOf(error)}`,
          );
        }
      }

      let retried: McpToolResult;
      try {
        retried = await options.client.callTool(
          {
            ...params,
            _meta: {
              ...params._meta,
              [X402_MCP_PAYMENT_META_KEY]: payload,
            },
          },
          ...args,
        );
      } catch (networkError) {
        throw new SettlementOutcomeError({
          kind: "ambiguous",
          reason: `the paid MCP tool call to ${params.name} failed after payment was sent: ${messageOf(networkError)}`,
          cause: networkError,
        });
      }

      if (retried.isError) {
        const anotherChallenge = extractPaymentRequired(retried);
        if (anotherChallenge) {
          pending.paymentRequired = anotherChallenge;
          pending.requirements = selectRequirements(
            anotherChallenge,
            caip2Network,
            resource,
            options.offerChecks,
          );
          throw new SettlementOutcomeError({
            kind: "retryable-with-fresh-auth",
            reason: `MCP tool ${params.name} answered the signed payment with another PaymentRequired`,
            signedTerms,
          });
        }
        throw new SettlementOutcomeError({
          kind: "fatal",
          reason: `MCP tool ${params.name} returned an error after payment`,
        });
      }

      const receipt = readMcpReceipt(retried, params.name, receiptMetaKey);
      pending.settledResult = retried;
      return receipt;
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
  });

  return {
    tollway,
    on(handler: ClientEventHandler): void {
      tollway.on(handler);
    },
    async callTool(params: McpCallToolParams, ...args: unknown[]): Promise<TollwayMcpCallResult> {
      const initial = await options.client.callTool(params, ...args);
      if (!initial.isError) {
        return { result: initial, paid: false };
      }

      const paymentRequired = extractPaymentRequired(initial);
      if (!paymentRequired) {
        return { result: initial, paid: false };
      }

      const resource = paymentRequired.resource?.url ?? `${resourcePrefix}/${params.name}`;
      const requirements = selectRequirements(
        paymentRequired,
        caip2Network,
        resource,
        options.offerChecks,
      );

      const offer: PaymentOffer = {
        resource,
        amount: requirements.amount,
        asset: requirements.asset,
        payTo: requirements.payTo,
        network: options.network,
        models: ["x402"],
      };

      if (options.onPaymentRequested) {
        const approved = await options.onPaymentRequested({
          toolName: params.name,
          paymentRequired,
          offer,
        });
        if (!approved) {
          throw new TollwayError(
            "policy-blocked",
            `payment for MCP tool "${params.name}" denied by onPaymentRequested`,
          );
        }
      }

      const pending: PendingMcpCall = {
        params,
        args,
        paymentRequired,
        requirements,
      };
      pendingCalls.set(resource, pending);
      try {
        const payResult = await tollway.pay({
          resource,
          offer,
          model: "x402",
        });
        if (!pending.settledResult) {
          throw new TollwayError(
            "payment-failed",
            `MCP tool ${params.name} settled without a tool result`,
          );
        }
        return {
          result: pending.settledResult,
          paid: true,
          receipt: payResult.receipt,
          model: payResult.model,
          deduplicated: payResult.deduplicated,
          ...(payResult.storeError ? { storeError: payResult.storeError } : {}),
        };
      } finally {
        pendingCalls.delete(resource);
      }
    },
  };
}

function isPaymentRequiredShape(value: unknown): value is PaymentRequired {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.x402Version === "number" && Array.isArray(record.accepts);
}

/**
 * Extracts `PaymentRequired` from an MCP error result. Checks:
 * 1. `result.structuredContent` (x402 MCP v2 primary location)
 * 2. `result._meta["x402/payment-required"]`
 * 3. First JSON text block in `result.content`
 */
export function extractPaymentRequired(result: McpToolResult): PaymentRequired | undefined {
  if (isPaymentRequiredShape(result.structuredContent)) {
    return result.structuredContent;
  }
  const metaChallenge = result._meta?.["x402/payment-required"];
  if (isPaymentRequiredShape(metaChallenge)) {
    return metaChallenge;
  }
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (isPaymentRequiredShape(parsed)) {
          return parsed;
        }
      } catch {
        // Not JSON; ignore and continue checking blocks.
      }
    }
  }
  return undefined;
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
      `the x402 MCP challenge for ${resource} has no Stellar exact option for ${caip2Network}${offerChecks ? " within the offer-check allowlists" : ""}`,
    );
  }
  return match;
}

function readMcpReceipt(
  result: McpToolResult,
  toolName: string,
  receiptMetaKey: string,
): SignedReceipt {
  const raw = result._meta?.[receiptMetaKey];
  if (raw === undefined) {
    throw new TollwayError(
      "invalid-receipt",
      `MCP tool ${toolName} settled the payment but sent no _meta["${receiptMetaKey}"] receipt`,
    );
  }
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      const decoded = new TextDecoder().decode(base64UrlToBytes(raw));
      candidate = JSON.parse(decoded);
    } catch {
      try {
        candidate = JSON.parse(raw);
      } catch (error) {
        throw new TollwayError(
          "invalid-receipt",
          `_meta["${receiptMetaKey}"] from MCP tool ${toolName} is not valid JSON or base64 JSON: ${messageOf(error)}`,
        );
      }
    }
  }
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError(
      "invalid-receipt",
      `_meta["${receiptMetaKey}"] from MCP tool ${toolName} is not a valid Tollway receipt`,
    );
  }
  return parsed.data;
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
      reason: `the MCP offer for ${resource} changed between attempts (${changed.join(", ")}); not signing again`,
    });
  }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
