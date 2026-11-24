/**
 * @vegaforge/tollway-mcp
 *
 * Server-side payment gating for MCP tool calls using Tollway's facilitator,
 * settlement cache, offer binding, and signed receipts (#206).
 *
 * Follows the x402 MCP transport specification:
 * - Unpaid calls return `isError: true` carrying `PaymentRequired`.
 * - Paid calls carry `PaymentPayload` in `_meta["x402/payment"]`.
 * - Order of operations: verify -> execute tool -> settle -> sign receipt,
 *   so a tool call that fails or returns `isError: true` is never charged.
 * - Successful paid calls return `_meta["x402/payment-response"]` (x402
 *   `SettleResponse`) and `_meta["tollway/receipt"]` (`SignedReceipt`).
 */

import {
  buildReceipt,
  hashOffer,
  type PaymentOffer,
  type ReceiptSigner,
  type SignedReceipt,
  type StellarNetwork,
  signReceipt,
  TollwayError,
  type X402Payment,
} from "@vegaforge/tollway-core";
import {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  type FacilitatorClient,
  type LockingSettlementCache,
  type SettlementCache,
  type SettlementEntry,
  stellarCaip2,
  toPaymentRequirements,
} from "@vegaforge/tollway-server";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { z } from "zod";

export const MCP_PAYMENT_META_KEY = "x402/payment";
export const MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";
export const MCP_TOLLWAY_RECEIPT_META_KEY = "tollway/receipt";

const x402PaymentSchema = z.object({
  x402Version: z.literal(2),
  accepted: z.object({
    scheme: z.string().min(1),
    network: z.string().min(1),
    asset: z.string().min(1),
    amount: z.string().regex(/^[0-9]+$/),
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().int().positive().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }),
  payload: z.record(z.string(), z.unknown()),
  resource: z
    .object({
      url: z.string().optional(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    })
    .optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

/** Minimal MCP tool result shape compatible with `@modelcontextprotocol/sdk`. */
export type McpToolResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** Extra context passed as the second argument to MCP tool handlers. */
export type McpToolExtra = {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type McpToolConfig = {
  /** MCP tool name, used in default `mcp://tool/<name>` resource URI. */
  toolName: string;
  /** Price as an integer string in the asset's smallest unit. */
  amount: string;
  /** Asset identifier (SAC contract address or CODE:ISSUER). */
  asset: string;
  /** Stellar address that receives payment. */
  payTo: string;
  network: StellarNetwork;
  /** Optional resource URI override. Defaults to `mcp://tool/<toolName>`. */
  resource?: string;
  /** Optional human-readable description for `PaymentRequired.resource`. */
  description?: string;
  /** Optional MIME type for `PaymentRequired.resource`. */
  mimeType?: string;
  /** Payment validity window in seconds. Defaults to `DEFAULT_MAX_TIMEOUT_SECONDS`. */
  maxTimeoutSeconds?: number;
  /** Scheme-specific metadata placed in `PaymentRequirements.extra`. */
  extra?: Record<string, unknown>;
};

export type McpPaywallDeps = {
  signer: ReceiptSigner;
  facilitator: FacilitatorClient;
  cache?: SettlementCache | LockingSettlementCache;
  onCacheError?: (error: Error) => void;
};

export type McpToolHandler<TArgs = Record<string, unknown>, TResult extends McpToolResult = McpToolResult> = (
  args: TArgs,
  extra?: McpToolExtra,
) => Promise<TResult> | TResult;

function buildPaymentRequired(config: McpToolConfig, resourceUrl: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.mimeType !== undefined ? { mimeType: config.mimeType } : {}),
    },
    accepts: [
      toPaymentRequirements({
        amount: config.amount,
        asset: config.asset,
        payTo: config.payTo,
        network: config.network,
        maxTimeoutSeconds: config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
        ...(config.extra !== undefined ? { extra: config.extra } : {}),
      }),
    ],
  };
}

function unpaidResult(paymentRequired: PaymentRequired, errorMessage?: string): McpToolResult {
  const body = errorMessage
    ? { ...paymentRequired, error: errorMessage }
    : paymentRequired;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body as unknown as Record<string, unknown>,
  };
}

function matchesOffer(payment: X402Payment, offer: PaymentOffer): string | null {
  const expectedNetwork = stellarCaip2(offer.network);
  if (payment.accepted.scheme !== "exact") {
    return `unsupported scheme: ${payment.accepted.scheme}`;
  }
  if (payment.accepted.network !== expectedNetwork) {
    return `network mismatch: expected ${expectedNetwork}, got ${payment.accepted.network}`;
  }
  if (payment.accepted.asset !== offer.asset) {
    return `asset mismatch: expected ${offer.asset}, got ${payment.accepted.asset}`;
  }
  if (payment.accepted.amount !== offer.amount) {
    return `amount mismatch: expected ${offer.amount}, got ${payment.accepted.amount}`;
  }
  if (payment.accepted.payTo !== offer.payTo) {
    return `payTo mismatch: expected ${offer.payTo}, got ${payment.accepted.payTo}`;
  }
  return null;
}

function cachedReceiptMatchesOffer(receipt: SignedReceipt, offer: PaymentOffer): boolean {
  return (
    receipt.resource === offer.resource &&
    receipt.amount === offer.amount &&
    receipt.asset === offer.asset &&
    receipt.payee === offer.payTo &&
    receipt.network === offer.network &&
    receipt.model === "x402"
  );
}

/**
 * Wraps an MCP tool handler with Tollway x402 payment gating.
 *
 * Unpaid calls receive an MCP tool error result containing `PaymentRequired`.
 * Paid calls verify the payment, execute the tool handler, and settle only if
 * the tool succeeds (`!result.isError` and no thrown error).
 */
export function createPaidMcpTool<
  TArgs = Record<string, unknown>,
  TResult extends McpToolResult = McpToolResult,
>(
  config: McpToolConfig,
  deps: McpPaywallDeps,
  handler: McpToolHandler<TArgs, TResult>,
): McpToolHandler<TArgs, McpToolResult> {
  if (!/^[0-9]+$/.test(config.amount)) {
    throw new TollwayError("invalid-amount", `invalid tool amount: ${config.amount}`);
  }
  const resourceUrl = config.resource ?? `mcp://tool/${config.toolName}`;
  const offer: PaymentOffer = {
    resource: resourceUrl,
    amount: config.amount,
    asset: config.asset,
    payTo: config.payTo,
    network: config.network,
    models: ["x402"],
  };
  const inFlight = new Map<string, Promise<McpToolResult>>();

  async function safeCacheSet(key: string, entry: SettlementEntry): Promise<void> {
    if (!deps.cache) return;
    try {
      await deps.cache.set(key, entry);
    } catch (error) {
      deps.onCacheError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return async (args: TArgs, extra?: McpToolExtra): Promise<McpToolResult> => {
    const paymentRequired = buildPaymentRequired(config, resourceUrl);
    const rawPayment = extra?._meta?.[MCP_PAYMENT_META_KEY];
    if (rawPayment === undefined) {
      return unpaidResult(paymentRequired);
    }

    const parsed = x402PaymentSchema.safeParse(rawPayment);
    if (!parsed.success) {
      return unpaidResult(paymentRequired, "malformed x402/payment payload in _meta");
    }
    const payment = parsed.data as unknown as X402Payment;
    const mismatch = matchesOffer(payment, offer);
    if (mismatch !== null) {
      return unpaidResult(paymentRequired, mismatch);
    }

    // Check cache before verify using facilitator.idempotencyKey when available.
    const preKey = await deps.facilitator.idempotencyKey?.({ payment });
    if (preKey !== undefined && deps.cache) {
      const existing = await deps.cache.get(preKey);
      if (existing) {
        if (!cachedReceiptMatchesOffer(existing.receipt, offer)) {
          return unpaidResult(paymentRequired, "cached receipt does not match tool offer");
        }
        const replayResult = await handler(args, extra);
        const txHash =
          existing.receipt.settlement.kind === "tx" ? existing.receipt.settlement.txHash : "";
        const settleResponse: SettleResponse = {
          success: true,
          transaction: txHash,
          network: stellarCaip2(config.network),
          payer: existing.payer,
        };
        return {
          ...replayResult,
          _meta: {
            ...replayResult._meta,
            [MCP_PAYMENT_RESPONSE_META_KEY]: settleResponse,
            [MCP_TOLLWAY_RECEIPT_META_KEY]: existing.receipt,
          },
        };
      }
    }

    // Verify before executing the tool so invalid payments never run the tool.
    const verified = await deps.facilitator.verify({ payment, offer });
    if (!verified.valid) {
      return unpaidResult(paymentRequired, `payment verification failed: ${verified.reason}`);
    }

    const nonce = verified.nonce;
    const active = inFlight.get(nonce);
    if (active) {
      return active;
    }

    const run = (async (): Promise<McpToolResult> => {
      const lockingCache = deps.cache as LockingSettlementCache | undefined;
      const lock = lockingCache?.acquire ? await lockingCache.acquire(nonce) : null;
      if (lockingCache?.acquire && lock === null) {
        return {
          isError: true,
          content: [{ type: "text", text: "settlement already in progress for this payment" }],
        };
      }

      try {
        // Re-check cache after acquiring lock in case another caller just settled.
        if (deps.cache) {
          const cached = await deps.cache.get(nonce);
          if (cached) {
            if (!cachedReceiptMatchesOffer(cached.receipt, offer)) {
              return unpaidResult(paymentRequired, "cached receipt does not match tool offer");
            }
            const replayResult = await handler(args, extra);
            const txHash =
              cached.receipt.settlement.kind === "tx" ? cached.receipt.settlement.txHash : "";
            const settleResponse: SettleResponse = {
              success: true,
              transaction: txHash,
              network: stellarCaip2(config.network),
              payer: cached.payer,
            };
            return {
              ...replayResult,
              _meta: {
                ...replayResult._meta,
                [MCP_PAYMENT_RESPONSE_META_KEY]: settleResponse,
                [MCP_TOLLWAY_RECEIPT_META_KEY]: cached.receipt,
              },
            };
          }
        }

        // Execute tool BEFORE settling: a failed tool is never charged.
        let toolResult: TResult;
        try {
          toolResult = await handler(args, extra);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            isError: true,
            content: [{ type: "text", text: `tool execution failed: ${message}` }],
          };
        }
        if (toolResult.isError) {
          return toolResult;
        }

        const settled = await deps.facilitator.settle({
          payment,
          offer,
          payer: verified.payer,
          nonce,
        });
        if (!settled.settled) {
          return {
            isError: true,
            content: [{ type: "text", text: `settlement failed: ${settled.reason}` }],
          };
        }

        const receipt = await signReceipt(
          buildReceipt({
            resource: resourceUrl,
            amount: config.amount,
            asset: config.asset,
            payTo: config.payTo,
            payer: verified.payer,
            network: config.network,
            model: "x402",
            settlement: { kind: "tx", txHash: settled.txHash },
            offerHash: hashOffer(offer),
          }),
          deps.signer,
        );

        await safeCacheSet(nonce, {
          receipt,
          payer: verified.payer,
          model: "x402",
        });

        const settleResponse: SettleResponse = {
          success: true,
          transaction: settled.txHash,
          network: stellarCaip2(config.network),
          payer: verified.payer,
        };

        return {
          ...toolResult,
          _meta: {
            ...toolResult._meta,
            [MCP_PAYMENT_RESPONSE_META_KEY]: settleResponse,
            [MCP_TOLLWAY_RECEIPT_META_KEY]: receipt,
          },
        };
      } finally {
        await lock?.release().catch((error: unknown) => {
          deps.onCacheError?.(error instanceof Error ? error : new Error(String(error)));
        });
      }
    })();

    inFlight.set(nonce, run);
    try {
      return await run;
    } finally {
      inFlight.delete(nonce);
    }
  };
}
