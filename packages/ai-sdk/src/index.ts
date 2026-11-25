/**
 * A Vercel AI SDK tool that lets a model fetch paid URLs within a Tollway
 * budget (#208).
 *
 * `createPaidFetchTool` builds a `paid_fetch` tool with the AI SDK's `tool()`
 * helper. The paying itself is the caller's paid fetch (the client's
 * `createPaidFetch`, #201): it reads the 402, runs offer checks and policy,
 * signs, and verifies the receipt. This package adds only what a
 * model-driven caller needs on top: the model picks URLs, so the tool
 * refuses origins and methods the host did not allow before any request,
 * caps the body that goes back into the model's context, and turns a
 * refused payment into a structured result the model can reason about.
 *
 * The full signed receipt never enters the model's context. The host gets it
 * from the paid fetch's client events or receipt store.
 */

import {
  type PolicyEngine,
  type PolicyHeadroom,
  type SettlementModel,
  type SignedReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { type Tool, tool } from "ai";
import { z } from "zod";

/** Methods the model may ask for. The host narrows them with `methods`. */
export const PAID_FETCH_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type PaidFetchMethod = (typeof PAID_FETCH_METHODS)[number];

/** The default body cap, in bytes of the response body. */
export const DEFAULT_MAX_BODY_BYTES = 32_768;

/**
 * Request headers the model may not set. The payment and receipt headers
 * belong to the paid fetch, and a model has no business sending
 * credentials it should not hold.
 */
const RESERVED_HEADERS = new Set([
  "authorization",
  "cookie",
  "payment-signature",
  "x-payment",
  "tollway-receipt",
]);

export const paidFetchInputSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).describe("The http or https URL to fetch."),
  method: z.enum(PAID_FETCH_METHODS).optional().describe("The HTTP method. Defaults to GET."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Request headers. Payment and credential headers are not allowed."),
  body: z.string().optional().describe("The request body, for methods other than GET."),
});

export type PaidFetchInput = z.infer<typeof paidFetchInputSchema>;

/** The response a paid fetch resolves to: a `Response`, plus the receipt when it paid. */
export type PaidFetchResponse = Response & {
  receipt?: SignedReceipt;
  model?: SettlementModel;
};

/**
 * The request options the tool passes. Each field is one `fetch` accepts, so
 * a paid fetch typed with `RequestInit` fits {@link PaidFetchLike}.
 */
export type PaidFetchInit = {
  method?: PaidFetchMethod;
  headers?: Record<string, string>;
  body?: string;
  redirect?: "error";
  signal?: AbortSignal;
};

/**
 * The paid fetch the tool calls, such as the one `createPaidFetch` from
 * `@vegaforge/tollway-client` returns. It must forward `init.signal`.
 */
export type PaidFetchLike = (input: string, init?: PaidFetchInit) => Promise<PaidFetchResponse>;

/** What the model sees about a payment. No signature and no payment header. */
export type ReceiptSummary = {
  id: string;
  amount: string;
  asset: string;
  payee: string;
  model: SettlementModel;
};

/** Spend room left for the asset and payee just paid, as the policy reports it. */
export type RemainingBudget = {
  asset: string;
  payee: string;
  /** Base units left, or `null` when no rule limits this asset and payee. */
  remaining: string | null;
  /** The rule with the least room, or `null` when nothing limits it. */
  limitedBy: PolicyHeadroom["limitedBy"];
};

/** Why the tool refused a call or the payment was refused. */
export type PaidFetchBlockedRule =
  | "origin-not-allowed"
  | "method-not-allowed"
  | "header-not-allowed"
  | "redirect-not-allowed"
  | "counterparty-quarantined"
  | "offer-network-mismatch"
  | `policy:${string}`
  | `offer-check:${string}`;

export type PaidFetchToolResult =
  | {
      status: "ok";
      /** The HTTP status of the final response. */
      httpStatus: number;
      /** True when a payment settled for this call. */
      paid: boolean;
      body: string;
      /** True when the body was longer than the cap and was cut. */
      truncated: boolean;
      contentType?: string;
      receipt?: ReceiptSummary;
      remainingBudget?: RemainingBudget;
    }
  | {
      status: "blocked";
      rule: PaidFetchBlockedRule;
      detail: string;
    };

export type CreatePaidFetchToolOptions = {
  /** Pays the 402s. Configure its offer checks for the per-call price ceiling. */
  paidFetch: PaidFetchLike;
  /**
   * Origins the model may fetch, such as `https://api.example.com`. Required
   * and non-empty: a model choosing URLs must not reach arbitrary hosts.
   */
  allowedOrigins: readonly string[];
  /** Methods the model may use. Defaults to `["GET"]`. */
  methods?: readonly PaidFetchMethod[];
  /** Most response-body bytes returned to the model. Defaults to 32 KiB. */
  maxBodyBytes?: number;
  /**
   * The policy engine the paid fetch uses. When set and it reports headroom,
   * a paid result carries the spend room left for that asset and payee.
   */
  policy?: PolicyEngine;
  /** Replaces the generated description the model reads. */
  description?: string;
};

export type PaidFetchTool = Tool<PaidFetchInput, PaidFetchToolResult>;

/**
 * Builds the `paid_fetch` tool. Register it under any name in `tools`.
 *
 * Refusals the model can act on (an origin or method the host did not
 * allow, a policy block, an offer over the per-call ceiling) come back as
 * `{ status: "blocked", rule, detail }`. Anything else, including an abort
 * and a payment whose outcome is unknown, is thrown so the run sees it.
 */
export function createPaidFetchTool(options: CreatePaidFetchToolOptions): PaidFetchTool {
  const allowedOrigins = normaliseOrigins(options.allowedOrigins);
  const methods = new Set<string>(options.methods ?? ["GET"]);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError("createPaidFetchTool: maxBodyBytes must be a positive integer");
  }

  return tool({
    description: options.description ?? describeTool(allowedOrigins, methods, maxBodyBytes),
    inputSchema: paidFetchInputSchema,
    async execute(input, { abortSignal }): Promise<PaidFetchToolResult> {
      const refusal = refuseBeforeRequest(input, allowedOrigins, methods);
      if (refusal) return refusal;

      // An aborted generation sends nothing, so nothing can be half paid.
      abortSignal?.throwIfAborted();

      const method = input.method ?? "GET";
      let response: PaidFetchResponse;
      try {
        response = await options.paidFetch(input.url, {
          method,
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.body !== undefined && method !== "GET" ? { body: input.body } : {}),
          // A redirect could leave the allowed origins after the check above.
          redirect: "error",
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
      } catch (error) {
        const blocked = blockedResult(error);
        if (blocked) return blocked;
        throw error;
      }

      if (response.url !== "" && !allowedOrigins.has(originOf(response.url))) {
        await response.body?.cancel();
        return {
          status: "blocked",
          rule: "redirect-not-allowed",
          detail: `the response came from ${originOf(response.url)}, which is not an allowed origin`,
        };
      }

      const { body, truncated } = await readCappedBody(response, maxBodyBytes);
      const contentType = response.headers.get("content-type") ?? undefined;
      const receipt = response.receipt;
      const remainingBudget = receipt ? await headroomFor(options.policy, receipt) : undefined;
      return {
        status: "ok",
        httpStatus: response.status,
        paid: receipt !== undefined,
        body,
        truncated,
        ...(contentType ? { contentType } : {}),
        ...(receipt ? { receipt: summarise(receipt, response.model) } : {}),
        ...(remainingBudget ? { remainingBudget } : {}),
      };
    },
  });
}

function normaliseOrigins(origins: readonly string[]): Set<string> {
  if (origins.length === 0) {
    throw new TypeError("createPaidFetchTool: allowedOrigins must name at least one origin");
  }
  const normalised = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError(`createPaidFetchTool: "${origin}" is not a URL origin`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new TypeError(`createPaidFetchTool: "${origin}" is not an http or https origin`);
    }
    normalised.add(parsed.origin);
  }
  return normalised;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function refuseBeforeRequest(
  input: PaidFetchInput,
  allowedOrigins: Set<string>,
  methods: Set<string>,
): PaidFetchToolResult | undefined {
  const origin = originOf(input.url);
  if (!allowedOrigins.has(origin)) {
    return {
      status: "blocked",
      rule: "origin-not-allowed",
      detail: `${origin} is not an allowed origin; allowed: ${[...allowedOrigins].join(", ")}`,
    };
  }
  const method = input.method ?? "GET";
  if (!methods.has(method)) {
    return {
      status: "blocked",
      rule: "method-not-allowed",
      detail: `${method} is not allowed; allowed: ${[...methods].join(", ")}`,
    };
  }
  for (const name of Object.keys(input.headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return {
        status: "blocked",
        rule: "header-not-allowed",
        detail: `the ${name} header is set by the host, not the model`,
      };
    }
  }
  return undefined;
}

/**
 * Maps a refusal the model can act on to a blocked result. Returns
 * `undefined` for every other error, which the caller rethrows.
 */
function blockedResult(error: unknown): PaidFetchToolResult | undefined {
  if (!(error instanceof TollwayError)) return undefined;
  switch (error.code) {
    case "policy-blocked":
    case "budget-exceeded":
      return {
        status: "blocked",
        rule: `policy:${stringField(error, "rule") ?? error.code}`,
        detail: error.message,
      };
    case "offer-rejected":
      return {
        status: "blocked",
        rule: `offer-check:${stringField(error, "checkName") ?? "unknown"}`,
        detail: error.message,
      };
    case "counterparty-quarantined":
    case "offer-network-mismatch":
      return { status: "blocked", rule: error.code, detail: error.message };
    default:
      return undefined;
  }
}

/**
 * Reads a string field a client error subclass adds, such as
 * `PolicyBlockedError.rule`, without importing the client.
 */
function stringField(error: TollwayError, field: "rule" | "checkName"): string | undefined {
  if (!(field in error)) return undefined;
  const value: unknown = (error as TollwayError & Record<typeof field, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads at most `maxBytes` of the body and stops the download there, so a
 * large response is never buffered whole. A multi-byte character cut by the
 * cap is dropped rather than replaced.
 */
async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();
        return { body, truncated: false };
      }
      const room = maxBytes - read;
      if (value.byteLength > room) {
        body += decoder.decode(value.subarray(0, room), { stream: true });
        return { body, truncated: true };
      }
      read += value.byteLength;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
}

function summarise(receipt: SignedReceipt, model: SettlementModel | undefined): ReceiptSummary {
  const { id, amount, asset, payee } = receipt.receipt;
  return { id, amount, asset, payee, model: model ?? receipt.receipt.model };
}

async function headroomFor(
  policy: PolicyEngine | undefined,
  receipt: SignedReceipt,
): Promise<RemainingBudget | undefined> {
  if (!policy?.headroom) return undefined;
  const { asset, payee } = receipt.receipt;
  const room = await policy.headroom(asset, payee);
  return { asset, payee, remaining: room.headroom, limitedBy: room.limitedBy };
}

function describeTool(origins: Set<string>, methods: Set<string>, maxBodyBytes: number): string {
  return [
    "Fetch a URL, paying for it if the server asks for payment (HTTP 402).",
    `Only these origins are allowed: ${[...origins].join(", ")}.`,
    `Allowed methods: ${[...methods].join(", ")}.`,
    `The body is cut at ${maxBodyBytes} bytes, and the result says when it was.`,
    'A payment refused by the budget, the policy or a price limit returns status "blocked" with the rule that refused it; tell the user or choose another source instead of retrying.',
  ].join(" ");
}
