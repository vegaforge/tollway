/**
 * @vegaforge/tollway-mcp
 *
 * Paid MCP tools on the service side (#206). `paidTool(config, deps)(handler)`
 * wraps an MCP tool handler so that it speaks the x402 MCP transport
 * (specs/transports-v2/mcp.md in the x402 repository):
 *
 * - A call without `_meta["x402/payment"]` gets a tool result with
 *   `isError: true` carrying the x402 `PaymentRequired`, in both
 *   `structuredContent` and `content[0].text`.
 * - A paid call is verified, the tool runs, and the payment settles only if
 *   the tool succeeded. The result carries the x402 `SettleResponse` in
 *   `_meta["x402/payment-response"]` and the signed Tollway receipt in
 *   `_meta["tollway/receipt"]`.
 *
 * Verification, replay protection, settlement locking, receipt signing and
 * offer binding are not implemented here: they run through
 * `createPaidCall` in @vegaforge/tollway-server, the same settlement path the
 * HTTP gate uses. See docs/design.md, "Design notes" (the gating molecule).
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";
import {
  createPaidCall,
  type GateOutcome,
  type PaidCallConfig,
  type PaidCallDeps,
  stellarCaip2,
} from "@vegaforge/tollway-server";
import { PaymentPayloadV2Schema } from "@x402/core/schemas";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

/** Where a client puts its x402 `PaymentPayload` on a `tools/call` request. */
export const MCP_PAYMENT_META_KEY = "x402/payment";
/** Where a paid result carries the x402 `SettleResponse`. */
export const MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";
/** Where a paid result carries the signed Tollway receipt. */
export const MCP_TOLLWAY_RECEIPT_META_KEY = "tollway/receipt";
/**
 * The method a paid tool call's v2 receipt names. A cached receipt is only
 * replayed for the same method, so a tool receipt never unlocks an HTTP
 * route that happens to share its resource id.
 */
export const MCP_TOOL_CALL_METHOD = "tools/call";

/**
 * The parts of an MCP tool result this package reads and writes. It is a
 * structural subset of `CallToolResult` from `@modelcontextprotocol/sdk`, so
 * the package does not depend on a particular SDK version.
 */
export type McpToolResult = {
  content?: readonly unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** The parts of the MCP handler's second argument this package reads. */
export type McpToolExtra = {
  _meta?: Record<string, unknown>;
};

/** The tool result for a call that is not (or not yet) paid. */
export type McpPaymentRequiredResult = {
  isError: true;
  structuredContent: PaymentRequired & Record<string, unknown>;
  content: [{ type: "text"; text: string }];
};

/** A paid result: the tool's own result with the settlement metadata added. */
export type McpPaidResult<TResult extends McpToolResult> = TResult & {
  _meta: Record<string, unknown>;
};

/**
 * What a paid tool charges. The price fields match `createPaywall`'s
 * `PaywallConfig` (a fixed `amount`, `asset`, `payTo`, `network`, `models`,
 * `facilitatorUrl`, `maxTimeoutSeconds`, `extra`), plus the tool's name and an
 * optional stable resource id.
 */
export type PaidToolConfig = Omit<PaidCallConfig, "resource"> & {
  /** The MCP tool name. The default resource id is `mcp://tool/<toolName>`. */
  toolName: string;
  /**
   * The stable resource id the receipt names. Defaults to
   * `mcp://tool/<toolName>`, the id `@x402/mcp` uses. Keep it stable: a
   * cached receipt is only replayed for the same resource.
   */
  resource?: string;
};

/**
 * The services a paid tool uses, the same as `createPaywall`'s: the receipt
 * signer, the facilitator, the settlement cache and its hooks. Share the
 * cache with the HTTP gate and one payment settles at most once across both.
 */
export type PaidToolDeps = PaidCallDeps;

/** An MCP tool handler, as `McpServer.registerTool` calls it. */
export type McpToolHandler<TArgs, TExtra extends McpToolExtra, TResult extends McpToolResult> = (
  args: TArgs,
  extra: TExtra,
) => TResult | Promise<TResult>;

/** Wraps one tool handler with the payment gate. */
export type PaidToolWrapper = <TArgs, TExtra extends McpToolExtra, TResult extends McpToolResult>(
  handler: McpToolHandler<TArgs, TExtra, TResult>,
) => (
  args: TArgs,
  extra: TExtra,
) => Promise<McpPaidResult<TResult> | TResult | McpPaymentRequiredResult>;

/**
 * Gates an MCP tool with an x402 payment, settled after the tool succeeds.
 *
 * - No payment: `isError: true` with `PaymentRequired`; the tool does not run.
 * - A payment that is malformed, for other terms, or not verified: the same,
 *   with the reason in `PaymentRequired.error`; the tool does not run.
 * - A verified payment: the tool runs once. If it throws, the error goes to
 *   the MCP server as usual and nothing settles. If it returns
 *   `isError: true`, that result is returned and nothing settles. Otherwise
 *   the payment settles and the result carries the settlement and receipt.
 *   If settlement fails after the tool ran, only the payment error is
 *   returned, never the tool's content, as the x402 MCP transport requires.
 * - The same payment again (a retry after a lost answer): the receipt comes
 *   from the settlement cache, nothing settles again, and the tool runs
 *   again for the retry, as a replayed payment re-serves an HTTP route. Two
 *   copies of one payment in flight at once settle once.
 */
export function paidTool(config: PaidToolConfig, deps: PaidToolDeps): PaidToolWrapper {
  const { toolName, resource, ...price } = config;
  if (toolName.length === 0) {
    throw new TypeError("toolName must be a non-empty string");
  }
  const call = createPaidCall({ ...price, resource: resource ?? `mcp://tool/${toolName}` }, deps);
  const [requirements] = call.paymentRequired().accepts;
  if (!requirements) {
    throw new Error("the paid call built a challenge with no payment requirements");
  }

  return function wrap<TArgs, TExtra extends McpToolExtra, TResult extends McpToolResult>(
    handler: McpToolHandler<TArgs, TExtra, TResult>,
  ) {
    return async (
      args: TArgs,
      extra: TExtra,
    ): Promise<McpPaidResult<TResult> | TResult | McpPaymentRequiredResult> => {
      const raw = extra._meta?.[MCP_PAYMENT_META_KEY];
      if (raw === undefined) {
        return paymentRequiredResult(call.paymentRequired("Payment required to access this tool"));
      }
      const parsed = PaymentPayloadV2Schema.safeParse(raw);
      if (!parsed.success) {
        return paymentRequiredResult(
          call.paymentRequired(`${MCP_PAYMENT_META_KEY} is not an x402 V2 PaymentPayload`),
        );
      }
      const payment = toPaymentPayload(parsed.data);
      if (payment === undefined) {
        return paymentRequiredResult(
          call.paymentRequired("payment network is not a CAIP-2 network id"),
        );
      }
      const mismatch = termsMismatch(payment.accepted, requirements);
      if (mismatch !== undefined) {
        return paymentRequiredResult(call.paymentRequired(mismatch));
      }

      // Set only when this call ran the tool on the way to settling.
      let ran: { result: TResult } | undefined;
      const outcome = await call.settle({
        payment,
        method: MCP_TOOL_CALL_METHOD,
        beforeSettle: async () => {
          const result = await handler(args, extra);
          ran = { result };
          return result.isError !== true;
        },
      });

      if (outcome.kind === "settled") {
        const result = ran ? ran.result : await handler(args, extra);
        return withSettlement(result, outcome.receipt);
      }
      if (ran?.result.isError === true) {
        // The tool failed, so nothing settled: the agent sees the tool's error.
        return ran.result;
      }
      if (outcome.kind === "payment-required") {
        return paymentRequiredResult(outcome.challenge);
      }
      const reason = rejectionReason(outcome);
      return paymentRequiredResult(
        call.paymentRequired(ran ? `Payment settlement failed: ${reason}` : reason),
      );
    };
  };
}

/** The x402 MCP payment-required result: `structuredContent` and its JSON text. */
function paymentRequiredResult(paymentRequired: PaymentRequired): McpPaymentRequiredResult {
  return {
    isError: true,
    structuredContent: { ...paymentRequired },
    content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
  };
}

/** Adds the x402 `SettleResponse` and the Tollway receipt to a tool result. */
function withSettlement<TResult extends McpToolResult>(
  result: TResult,
  signed: SignedReceipt,
): McpPaidResult<TResult> {
  const { receipt } = signed;
  const settleResponse: SettleResponse = {
    success: true,
    // Paid tool calls settle by x402, whose receipts carry a transaction.
    transaction: receipt.settlement.kind === "transaction" ? receipt.settlement.txHash : "",
    network: stellarCaip2(receipt.network),
    payer: receipt.payer,
  };
  return {
    ...result,
    _meta: {
      ...result._meta,
      [MCP_PAYMENT_RESPONSE_META_KEY]: settleResponse,
      [MCP_TOLLWAY_RECEIPT_META_KEY]: signed,
    },
  };
}

/**
 * Why the payment's `accepted` terms do not answer this tool's challenge, or
 * undefined when they do. Checked before the facilitator is called, the way
 * `@x402/mcp` matches requirements; the facilitator verifies against the
 * same requirements again.
 */
function termsMismatch(
  accepted: PaymentRequirements,
  required: PaymentRequirements,
): string | undefined {
  for (const field of ["scheme", "network", "asset", "amount", "payTo"] as const) {
    if (accepted[field] !== required[field]) {
      return `payment ${field} does not match this tool: expected ${required[field]}, got ${accepted[field]}`;
    }
  }
  return undefined;
}

/**
 * The schema-checked payload as the `PaymentPayload` type, or undefined when
 * its network is not a CAIP-2 id (the schema accepts any string there).
 */
function toPaymentPayload(
  data: ReturnType<typeof PaymentPayloadV2Schema.parse>,
): PaymentPayload | undefined {
  const { x402Version, resource, accepted, payload, extensions } = data;
  if (!isCaip2(accepted.network)) return undefined;
  return {
    x402Version,
    ...(resource ? { resource } : {}),
    // x402 V2 requirements always carry `extra`; the schema lets a client
    // omit it, which means the same as an empty object.
    accepted: { ...accepted, network: accepted.network, extra: accepted.extra ?? {} },
    payload,
    ...(extensions ? { extensions } : {}),
  };
}

function isCaip2(value: string): value is Network {
  return /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(value);
}

/** The rejection reason, with the wait the gate asked for when it gave one. */
function rejectionReason(outcome: Extract<GateOutcome, { kind: "rejected" }>): string {
  // The gate keeps the facilitator's or validator's own words in
  // `upstreamReason` and a generic sentence in `reason`. An MCP client has
  // no separate field for them, so the specific one goes in the message.
  const reason = outcome.upstreamReason ?? outcome.reason;
  const retryAfter = outcome.headers?.["retry-after"];
  return retryAfter === undefined ? reason : `${reason} (retry after ${retryAfter}s)`;
}
