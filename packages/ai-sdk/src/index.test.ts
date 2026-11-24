import { createClient, type OfferChecks } from "@vegaforge/tollway-client";
import {
  buildReceipt,
  createPolicyEngine,
  Ed25519Signer,
  type PaymentOffer,
  type PolicyEngine,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { generateText, stepCountIs, type ToolExecutionOptions } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type CreatePaidFetchToolOptions,
  createPaidFetchTool,
  type PaidFetchInput,
  type PaidFetchLike,
  type PaidFetchToolResult,
  paidFetchInputSchema,
} from "./index.js";

const API = "https://api.example.com";
const PAYEE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAYER = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

let serviceSigner: Ed25519Signer;

beforeAll(async () => {
  serviceSigner = await Ed25519Signer.generate("data-service");
});

type FakeService = {
  paidFetch: PaidFetchLike;
  /** Requests that left the agent, paid or not. */
  sent: { url: string; init: RequestInit | undefined }[];
  /** Payments that settled. */
  settled: number;
};

type FakeServiceOptions = {
  price?: string;
  policy?: PolicyEngine;
  offerChecks?: OfferChecks;
  body?: string;
  /** Runs after the 402 arrives and before the payment is signed. */
  after402?: () => void | Promise<void>;
  /** The URL the final response claims to come from, as after a redirect. */
  finalUrl?: string;
};

/**
 * A stand-in for `createPaidFetch`: every URL answers 402, and the payment
 * goes through a real Tollway client with a real policy engine, so the
 * errors the tool sees are the ones the client throws.
 */
function fakeService(options: FakeServiceOptions = {}): FakeService {
  const service: FakeService = { paidFetch: async () => new Response(), sent: [], settled: 0 };
  const client = createClient({
    network: "testnet",
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.offerChecks ? { offerChecks: options.offerChecks } : {}),
    settler: {
      payer: PAYER,
      async settle({ resource, offer }) {
        service.settled += 1;
        return signReceipt(
          buildReceipt({
            model: "x402",
            network: "testnet",
            payer: PAYER,
            payee: offer.payTo,
            amount: offer.amount,
            asset: offer.asset,
            resource,
            settlement: { kind: "transaction", txHash: "b".repeat(64) },
          }),
          serviceSigner,
        );
      },
    },
  });

  service.paidFetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    service.sent.push({ url, init });
    await options.after402?.();
    init?.signal?.throwIfAborted();
    const offer: PaymentOffer = {
      resource: url,
      amount: options.price ?? "5000",
      asset: USDC,
      payTo: PAYEE,
      network: "testnet",
      models: ["x402"],
    };
    const paid = await client.pay({ resource: url, offer, model: "x402" });
    const response = new Response(options.body ?? '{"price":42}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    if (options.finalUrl) Object.defineProperty(response, "url", { value: options.finalUrl });
    return Object.assign(response, { receipt: paid.receipt, model: paid.model });
  };
  return service;
}

function makeTool(service: FakeService, options: Partial<CreatePaidFetchToolOptions> = {}) {
  return createPaidFetchTool({ paidFetch: service.paidFetch, allowedOrigins: [API], ...options });
}

function executionOptions(abortSignal?: AbortSignal): ToolExecutionOptions<never> {
  return {
    toolCallId: "call-1",
    messages: [],
    context: undefined as never,
    ...(abortSignal ? { abortSignal } : {}),
  };
}

async function run(
  tool: ReturnType<typeof createPaidFetchTool>,
  input: PaidFetchInput,
  abortSignal?: AbortSignal,
): Promise<PaidFetchToolResult> {
  if (!tool.execute) throw new Error("the tool has no execute function");
  const output = await tool.execute(input, executionOptions(abortSignal));
  if (Symbol.asyncIterator in Object(output)) throw new Error("expected a single result");
  return output as PaidFetchToolResult;
}

describe("createPaidFetchTool", () => {
  it("pays for an allowed URL and returns the body and a receipt summary without the signature", async () => {
    const service = fakeService();

    const result = await run(makeTool(service), { url: `${API}/quote` });

    expect(result).toMatchObject({
      status: "ok",
      httpStatus: 200,
      paid: true,
      body: '{"price":42}',
      truncated: false,
      contentType: "application/json",
      receipt: { amount: "5000", asset: USDC, payee: PAYEE, model: "x402" },
    });
    expect(JSON.stringify(result)).not.toContain("signature");
    expect(service.settled).toBe(1);
  });

  it("refuses an origin that is not allowed before any request is made", async () => {
    const service = fakeService();

    const result = await run(makeTool(service), { url: "https://evil.example.com/steal" });

    expect(result).toEqual({
      status: "blocked",
      rule: "origin-not-allowed",
      detail: expect.stringContaining("https://evil.example.com"),
    });
    expect(service.sent).toHaveLength(0);
  });

  it("refuses a method the host did not allow before any request is made", async () => {
    const service = fakeService();

    const result = await run(makeTool(service), { url: `${API}/quote`, method: "DELETE" });

    expect(result).toMatchObject({ status: "blocked", rule: "method-not-allowed" });
    expect(service.sent).toHaveLength(0);
  });

  it("refuses a payment or credential header set by the model", async () => {
    const service = fakeService();

    const result = await run(makeTool(service), {
      url: `${API}/quote`,
      headers: { "PAYMENT-SIGNATURE": "forged" },
    });

    expect(result).toMatchObject({ status: "blocked", rule: "header-not-allowed" });
    expect(service.sent).toHaveLength(0);
  });

  it("returns a policy block as a structured result naming the rule", async () => {
    const service = fakeService({ policy: createPolicyEngine({ budgets: { daily: "1000" } }) });

    const result = await run(makeTool(service), { url: `${API}/quote` });

    expect(result).toMatchObject({ status: "blocked", rule: "policy:budget" });
    expect(service.settled).toBe(0);
  });

  it("returns a price over the per-call ceiling as a structured result", async () => {
    const service = fakeService({ offerChecks: { maxAmount: { [USDC]: "100" } } });

    const result = await run(makeTool(service), { url: `${API}/quote` });

    expect(result).toMatchObject({ status: "blocked", rule: "offer-check:maxAmount" });
    expect(service.settled).toBe(0);
  });

  it("throws an unexpected error instead of hiding it in a result", async () => {
    const paidFetch: PaidFetchLike = async () => {
      throw new TollwayError("outcome-unknown", "the payment may have settled");
    };
    const tool = createPaidFetchTool({ paidFetch, allowedOrigins: [API] });

    await expect(run(tool, { url: `${API}/quote` })).rejects.toMatchObject({
      code: "outcome-unknown",
    });
  });

  it("sends nothing when the generation was aborted before the call", async () => {
    const service = fakeService();
    const controller = new AbortController();
    controller.abort();

    await expect(
      run(makeTool(service), { url: `${API}/quote` }, controller.signal),
    ).rejects.toThrow();
    expect(service.sent).toHaveLength(0);
    expect(service.settled).toBe(0);
  });

  it("forwards the abort signal, so aborting after the 402 stops the payment", async () => {
    const controller = new AbortController();
    const service = fakeService({ after402: () => controller.abort() });

    await expect(
      run(makeTool(service), { url: `${API}/quote` }, controller.signal),
    ).rejects.toThrow();
    expect(service.sent).toHaveLength(1);
    expect(service.sent[0]?.init?.signal).toBe(controller.signal);
    expect(service.settled).toBe(0);
  });

  it("asks the paid fetch not to follow redirects", async () => {
    const service = fakeService();

    await run(makeTool(service), { url: `${API}/quote` });

    expect(service.sent[0]?.init?.redirect).toBe("error");
  });

  it("withholds the body of a response that came from another origin", async () => {
    const service = fakeService({ finalUrl: "https://evil.example.com/landing" });

    const result = await run(makeTool(service), { url: `${API}/quote` });

    expect(result).toMatchObject({ status: "blocked", rule: "redirect-not-allowed" });
    expect(JSON.stringify(result)).not.toContain("price");
  });

  it("cuts the body at the cap and flags the cut", async () => {
    const service = fakeService({ body: "x".repeat(100) });

    const result = await run(makeTool(service, { maxBodyBytes: 10 }), { url: `${API}/quote` });

    expect(result).toMatchObject({ status: "ok", body: "x".repeat(10), truncated: true });
  });

  it("counts the cap in bytes and drops a character the cap cuts in half", async () => {
    // "é" is two bytes in UTF-8, so a 5-byte cap fits two of them.
    const service = fakeService({ body: "ééé" });

    const result = await run(makeTool(service, { maxBodyBytes: 5 }), { url: `${API}/quote` });

    expect(result).toMatchObject({ body: "éé", truncated: true });
  });

  it("does not flag a body that fits the cap exactly", async () => {
    const service = fakeService({ body: "x".repeat(10) });

    const result = await run(makeTool(service, { maxBodyBytes: 10 }), { url: `${API}/quote` });

    expect(result).toMatchObject({ body: "x".repeat(10), truncated: false });
  });

  it("reports the spend room left when the policy engine can say", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "20000" } });
    const service = fakeService({ policy });

    const result = await run(makeTool(service, { policy }), { url: `${API}/quote` });

    expect(result).toMatchObject({
      status: "ok",
      remainingBudget: { asset: USDC, payee: PAYEE, remaining: "15000", limitedBy: "budget-daily" },
    });
  });

  it("rejects an empty origin allowlist at construction", () => {
    expect(() =>
      createPaidFetchTool({ paidFetch: fakeService().paidFetch, allowedOrigins: [] }),
    ).toThrow(TypeError);
  });

  it("accepts only http and https URLs from the model", () => {
    expect(paidFetchInputSchema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(paidFetchInputSchema.safeParse({ url: `${API}/quote` }).success).toBe(true);
  });
});

describe("paid_fetch inside generateText with a mock model", () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };

  function modelCalling(url: string) {
    return new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "paid_fetch",
              input: JSON.stringify({ url }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
  }

  it("hands the model a paid result it can read", async () => {
    const service = fakeService();

    const result = await generateText({
      model: modelCalling(`${API}/quote`),
      tools: { paid_fetch: makeTool(service) },
      stopWhen: stepCountIs(2),
      prompt: "What is the price?",
    });

    const output = result.steps[0]?.toolResults[0]?.output;
    expect(output).toMatchObject({ status: "ok", paid: true, body: '{"price":42}' });
    expect(service.settled).toBe(1);
  });

  it("hands the model a structured block instead of failing the run", async () => {
    const service = fakeService({ policy: createPolicyEngine({ budgets: { daily: "1000" } }) });

    const result = await generateText({
      model: modelCalling(`${API}/quote`),
      tools: { paid_fetch: makeTool(service) },
      stopWhen: stepCountIs(2),
      prompt: "What is the price?",
    });

    expect(result.text).toBe("done");
    expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({
      status: "blocked",
      rule: "policy:budget",
    });
  });
});
