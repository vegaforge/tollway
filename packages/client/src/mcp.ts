/**
 * Pays for MCP tool calls through the Tollway client (#207).
 *
 * Wraps an MCP client's `callTool`. When a tool answers with the x402 MCP
 * payment-required result, the wrapper maps the challenge to a Tollway offer
 * and calls `pay()`, so the payment passes the same offer checks, quarantine,
 * policy, retry rules, receipt verification, receipt-to-offer binding and
 * receipt store as an HTTP payment. The settler then repeats the tool call
 * with the signed payment and reads the Tollway receipt the tool returns.
 *
 * Wire format, as implemented by the published `@x402/mcp` 2.31 client:
 * - An unpaid call returns `isError: true` with an x402 V2 `PaymentRequired`
 *   in `structuredContent`, or JSON-encoded in the first text block.
 * - The client repeats the call with the `PaymentPayload` in
 *   `_meta["x402/payment"]`.
 * - A settled call returns the tool result with `_meta["x402/payment-response"]`
 *   and, from a Tollway gate (#206), the signed receipt in
 *   `_meta["tollway/receipt"]`.
 *
 * `@x402/mcp`'s own client is not wrapped because its approval hook runs
 * before Tollway could apply policy and its retry loop would sign again
 * outside the client's retry rules. See docs/design.md, "Architecture".
 *
 * The wrapper is typed against the shape of an MCP client, not the MCP SDK,
 * so this subpath does not import the SDK. Tool arguments and results are
 * never logged or put in error messages: they can carry user data.
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
  signedReceiptSchema,
  TollwayError,
} from "@vegaforge/tollway-core";
import { x402Client } from "@x402/core/client";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { z } from "zod";
import {
  type ClientEvent,
  type ClientEventHandler,
  type ClientSettler,
  createClient,
  PolicyBlockedError,
  type SettleRequest,
  type TollwayClient,
} from "./index.js";
import { type OfferChecks, passesAllowlists, validateOfferChecks } from "./offer-checks.js";
import { messageOf } from "./receipt-header.js";
import type { ReceiptStore } from "./receipt-store.js";
import { type RetryOptions, SettlementOutcomeError, type SignedTerms } from "./retry.js";

/** `_meta` key carrying the signed x402 payment on the repeated call. */
export const X402_MCP_PAYMENT_META_KEY = "x402/payment";
/** `_meta` key carrying the x402 settlement response on a paid result. */
export const X402_MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";
/** `_meta` key carrying the signed Tollway receipt on a paid result (#206). */
export const TOLLWAY_MCP_RECEIPT_META_KEY = "tollway/receipt";

const CAIP2: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

/**
 * The parts of an MCP `CallToolResult` the wrapper reads. Other fields are
 * kept as they arrived, so a result passed through is the tool's own.
 */
const mcpToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

export type McpToolResult = z.infer<typeof mcpToolResultSchema>;

export type McpCallToolParams = {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * What the wrapper needs from an MCP client. The MCP SDK's `Client` fits it;
 * anything after `params` (the SDK's result schema and request options) is
 * passed through on both the first call and the paid one.
 */
export interface McpClientLike {
  callTool(params: McpCallToolParams, ...rest: unknown[]): Promise<unknown>;
}

export type McpPaymentSignInput = {
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
  offer: PaymentOffer;
};

export type TollwayMcpClientOptions = {
  /** The MCP client whose `callTool` is wrapped. */
  client: McpClientLike;
  network: StellarNetwork;
  /** Signs the x402 Soroban auth entry. Required unless `signPayment` is set. */
  signer?: ClientStellarSigner;
  /**
   * Builds the x402 payment payload instead of the built-in Stellar exact
   * scheme, for a custodial or remote signer. Set `payer` with it so the
   * client can check who the receipt says paid.
   */
  signPayment?: (input: McpPaymentSignInput) => Promise<PaymentPayload>;
  /**
   * The Stellar address payments come from. Taken from `signer` when that is
   * set. When known, the client requires `receipt.payer` to equal it.
   */
  payer?: string;
  /** Soroban RPC URL for the x402 simulation. Defaults to the public one. */
  rpcUrl?: string;
  /**
   * Runs after the policy-free checks pass and before `pay()`, with the tool
   * name and the offer. Returning `false` refuses the payment with a
   * `PolicyBlockedError` whose rule is `onPaymentRequested`. Use it for a
   * human approval step; budgets and limits belong in `policy`.
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
  /** The tool result. For a paid call, the result of the paid call. */
  result: McpToolResult;
  paid: boolean;
  /** The verified receipt, when the call was paid. */
  receipt?: SignedReceipt;
  model?: SettlementModel;
  deduplicated?: boolean;
  /** Set when the receipt store failed after the payment settled. */
  storeError?: Error;
};

export interface TollwayMcpClient {
  callTool(params: McpCallToolParams, ...rest: unknown[]): Promise<TollwayMcpCallResult>;
  /** Subscribes to the client's events, including approval refusals. */
  on(handler: ClientEventHandler): void;
  /** The underlying Tollway client. */
  readonly tollway: TollwayClient;
}

/** One paid call's state, read by the settler while that call is paying. */
type PendingMcpCall = {
  params: McpCallToolParams;
  rest: unknown[];
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
  settledResult?: McpToolResult;
};

/**
 * Wraps an MCP client so a paid tool call goes through Tollway's offer
 * checks, policy, retry rules and receipt verification before its result is
 * returned. A tool error that is not a payment request is returned as it
 * arrived and never triggers a payment.
 */
export function createTollwayMcpClient(options: TollwayMcpClientOptions): TollwayMcpClient {
  if (!options.signer && !options.signPayment) {
    throw new TypeError("createTollwayMcpClient: either signer or signPayment is required");
  }
  if (options.offerChecks) {
    validateOfferChecks(options.offerChecks, options.network);
  }

  const caip2Network = CAIP2[options.network];
  const payer = options.signer?.address ?? options.payer;
  const scheme = options.signer
    ? new ExactStellarScheme(options.signer, options.rpcUrl ? { url: options.rpcUrl } : undefined)
    : undefined;

  // The client's settler only learns the resource, so one paid call per
  // resource may be in flight at a time. Calls to the same tool queue here;
  // without that, two concurrent calls share a pending entry and one call's
  // arguments are sent with the other's payment.
  const pendingCalls = new Map<string, PendingMcpCall>();
  const resourceQueues = new Map<string, Promise<void>>();
  let callCounter = 0;

  const handlers: ClientEventHandler[] = [];
  function emit(event: ClientEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // A throwing subscriber must not change the outcome of a payment.
      }
    }
  }

  async function signPayload(
    pending: PendingMcpCall,
    offer: PaymentOffer,
    resource: string,
  ): Promise<PaymentPayload> {
    const { paymentRequired, requirements } = pending;
    if (options.signPayment) {
      return options.signPayment({ paymentRequired, requirements, offer });
    }
    if (!scheme) {
      throw new TollwayError("payment-failed", "no x402 signer configured for MCP payments");
    }
    const x402 = x402Client.fromConfig({
      schemes: [{ network: caip2Network, client: scheme }],
      spendControls: {
        allowedAssets: [
          { network: caip2Network, asset: requirements.asset, maxAmountPerPayment: offer.amount },
        ],
      },
    });
    // Only the option the policy approved may be signed.
    x402.registerPolicy((_version, candidates) =>
      candidates.filter((option) => sameOption(option, requirements)),
    );
    try {
      return await x402.createPaymentPayload(paymentRequired);
    } catch (error) {
      throw new TollwayError(
        "payment-failed",
        `could not sign the x402 payment for ${resource}: ${messageOf(error)}`,
      );
    }
  }

  const settler: ClientSettler = {
    ...(payer === undefined ? {} : { payer }),
    async settle({ resource, offer, model, pinned }: SettleRequest): Promise<SignedReceipt> {
      if (model !== "x402") {
        throw new TollwayError("payment-failed", `MCP tools are paid by x402, not "${model}"`);
      }
      const pending = pendingCalls.get(resource);
      if (!pending) {
        throw new TollwayError("payment-failed", `no pending MCP tool call for ${resource}`);
      }
      const { params, rest, requirements } = pending;
      if (pinned) assertMatchesPinned(requirements, pinned, resource);
      const signedTerms: SignedTerms = {
        amount: requirements.amount,
        asset: requirements.asset,
        payTo: requirements.payTo,
      };

      const payload = await signPayload(pending, offer, resource);

      let raw: unknown;
      try {
        raw = await options.client.callTool(
          { ...params, _meta: { ...params._meta, [X402_MCP_PAYMENT_META_KEY]: payload } },
          ...rest,
        );
      } catch (error) {
        // The payment left with the request, so it may have settled.
        throw new SettlementOutcomeError({
          kind: "ambiguous",
          reason: `the paid call to MCP tool ${params.name} failed after the payment was sent: ${messageOf(error)}`,
          cause: error,
        });
      }
      const paid = parseToolResult(raw, params.name);

      if (paid.isError) {
        const next = extractPaymentRequired(paid);
        if (next) {
          // The tool did not accept the payment. A retry signs the new
          // challenge, and only if its terms equal the ones signed here.
          pending.paymentRequired = next;
          pending.requirements = selectRequirements(
            next,
            caip2Network,
            resource,
            options.offerChecks,
          );
          throw new SettlementOutcomeError({
            kind: "retryable-with-fresh-auth",
            reason: `MCP tool ${params.name} answered the signed payment with another payment request`,
            signedTerms,
          });
        }
        // A Tollway gate settles only when the tool succeeds (#206), so an
        // error here means the payment was not taken.
        throw new SettlementOutcomeError({
          kind: "fatal",
          reason: `MCP tool ${params.name} returned an error to the paid call`,
        });
      }

      const receipt = readMcpReceipt(paid, params.name);
      pending.settledResult = paid;
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
  tollway.on(emit);

  /** Runs `task` after every earlier paid call to `resource` has finished. */
  async function serialised<T>(resource: string, task: () => Promise<T>): Promise<T> {
    const previous = resourceQueues.get(resource) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    resourceQueues.set(resource, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (resourceQueues.get(resource) === tail) resourceQueues.delete(resource);
    }
  }

  async function payForCall(
    params: McpCallToolParams,
    rest: unknown[],
    paymentRequired: PaymentRequired,
  ): Promise<TollwayMcpCallResult> {
    const resource = paymentRequired.resource.url;
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
        const error = new PolicyBlockedError(
          "onPaymentRequested",
          `the payment for MCP tool ${params.name} was not approved`,
        );
        emit({ type: "skip", resource, reason: error.message });
        throw error;
      }
    }

    return serialised(resource, async () => {
      const pending: PendingMcpCall = { params, rest, paymentRequired, requirements };
      pendingCalls.set(resource, pending);
      try {
        // Each tool call is its own purchase: two calls with the same price
        // must not share one settlement.
        callCounter += 1;
        const payResult = await tollway.pay({
          resource,
          offer,
          model: "x402",
          idempotencyKey: `mcp-call:${callCounter}`,
        });
        if (!pending.settledResult) {
          throw new TollwayError(
            "payment-failed",
            `MCP tool ${params.name} settled without returning a tool result`,
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
    });
  }

  return {
    tollway,
    on(handler) {
      handlers.push(handler);
    },
    async callTool(params, ...rest) {
      const initial = parseToolResult(await options.client.callTool(params, ...rest), params.name);
      const paymentRequired = extractPaymentRequired(initial);
      if (!paymentRequired) {
        return { result: initial, paid: false };
      }
      return payForCall(params, rest, paymentRequired);
    },
  };
}

/**
 * Reads the x402 V2 `PaymentRequired` from an MCP tool error, where the x402
 * MCP transport puts it: `structuredContent`, or JSON in the first text
 * block. Returns `undefined` for a successful result, for an error that is
 * not a payment request, and for a challenge that fails the x402 schema.
 */
export function extractPaymentRequired(result: unknown): PaymentRequired | undefined {
  const parsed = mcpToolResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.isError !== true) return undefined;
  const { structuredContent, content } = parsed.data;

  if (structuredContent !== undefined) {
    const fromStructured = toPaymentRequired(structuredContent);
    if (fromStructured) return fromStructured;
  }

  const first = content[0];
  if (first?.type !== "text" || typeof first.text !== "string") return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(first.text);
  } catch {
    // Plain-text error message: not a payment request.
    return undefined;
  }
  return toPaymentRequired(decoded);
}

/** Parses an x402 V2 challenge whose every network is a CAIP-2 id. */
function toPaymentRequired(value: unknown): PaymentRequired | undefined {
  const parsed = PaymentRequiredV2Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const accepts: PaymentRequirements[] = [];
  for (const option of parsed.data.accepts) {
    const { network, extra, ...terms } = option;
    if (!isCaip2(network)) return undefined;
    accepts.push({ ...terms, network, extra: extra ?? {} });
  }
  const { extensions, ...challenge } = parsed.data;
  return { ...challenge, accepts, ...(extensions ? { extensions } : {}) };
}

function isCaip2(network: string): network is `${string}:${string}` {
  return /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(network);
}

function parseToolResult(raw: unknown, toolName: string): McpToolResult {
  const parsed = mcpToolResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TollwayError(
      "payment-failed",
      `MCP tool ${toolName} returned something that is not a tool result`,
    );
  }
  return parsed.data;
}

function selectRequirements(
  paymentRequired: PaymentRequired,
  caip2Network: string,
  resource: string,
  offerChecks: OfferChecks | undefined,
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
      `the payment request for ${resource} has no Stellar exact option on ${caip2Network}${offerChecks ? " within the offer-check allowlists" : ""}`,
    );
  }
  return match;
}

/**
 * The receipt a Tollway gate puts in `_meta`. It is checked again by the
 * client (signature, offer binding, payer, clock skew) before `pay()` returns.
 */
function readMcpReceipt(result: McpToolResult, toolName: string): SignedReceipt {
  const raw = result._meta?.[TOLLWAY_MCP_RECEIPT_META_KEY];
  if (raw === undefined) {
    throw new TollwayError(
      "invalid-receipt",
      `MCP tool ${toolName} accepted the payment but returned no _meta["${TOLLWAY_MCP_RECEIPT_META_KEY}"] receipt`,
    );
  }
  const parsed = signedReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TollwayError(
      "invalid-receipt",
      `_meta["${TOLLWAY_MCP_RECEIPT_META_KEY}"] from MCP tool ${toolName} is not a Tollway receipt`,
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
      reason: `the payment request for ${resource} changed between attempts (${changed.join(", ")}); not signing again`,
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
