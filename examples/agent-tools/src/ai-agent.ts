/**
 * A Vercel AI SDK model that fetches a paid URL through the `paid_fetch`
 * tool (#208).
 *
 * The model is the AI SDK's mock language model, so the script runs without
 * an API key: it asks for the quote once, then asks for a URL on an origin
 * the host did not allow, and the tool refuses that before any request.
 *
 * The paid fetch below is a stand-in. It answers every request with the
 * terms a 402 would carry and pays through a real Tollway client, so the
 * policy and the receipt checks are real. Replace it with `createPaidFetch`
 * from `@vegaforge/tollway-client` once #201 ships; the tool takes either.
 */

import { pathToFileURL } from "node:url";
import { createPaidFetchTool, type PaidFetchLike } from "@vegaforge/tollway-ai-sdk";
import { createClient } from "@vegaforge/tollway-client";
import {
  buildReceipt,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  signReceipt,
} from "@vegaforge/tollway-core";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";

const API = "https://quotes.example.com";
const AGENT = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const SERVICE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const QUOTE_PRICE = "10000";

async function standInPaidFetch(): Promise<{
  paidFetch: PaidFetchLike;
  policy: ReturnType<typeof createPolicyEngine>;
}> {
  const serviceKey = await Ed25519Signer.generate("quotes");
  const policy = createPolicyEngine({ budgets: { daily: "50000" } });
  const client = createClient({
    network: "testnet",
    policy,
    verifier: Ed25519Verifier.forSigner(serviceKey),
    settler: {
      payer: AGENT,
      async settle({ resource, offer }) {
        return signReceipt(
          buildReceipt({
            model: "x402",
            network: "testnet",
            payer: AGENT,
            payee: offer.payTo,
            amount: offer.amount,
            asset: offer.asset,
            resource,
            settlement: { kind: "transaction", txHash: "c".repeat(64) },
          }),
          serviceKey,
        );
      },
    },
  });
  const paidFetch: PaidFetchLike = async (url, init) => {
    init?.signal?.throwIfAborted();
    const paid = await client.pay({
      resource: url,
      offer: {
        resource: url,
        amount: QUOTE_PRICE,
        asset: USDC,
        payTo: SERVICE,
        network: "testnet",
        models: ["x402"],
      },
    });
    const response = new Response(JSON.stringify({ pair: "XLM/USD", price: "0.4123" }), {
      headers: { "content-type": "application/json" },
    });
    return Object.assign(response, { receipt: paid.receipt, model: paid.model });
  };
  return { paidFetch, policy };
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCall(id: string, url: string) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: id,
        toolName: "paid_fetch",
        input: JSON.stringify({ url }),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

export async function runAiAgent() {
  const { paidFetch, policy } = await standInPaidFetch();
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("call-1", `${API}/xlm-usd`),
      toolCall("call-2", "https://elsewhere.example.com/xlm-usd"),
      {
        content: [{ type: "text", text: "XLM/USD is 0.4123." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });

  const result = await generateText({
    model,
    tools: { paid_fetch: createPaidFetchTool({ paidFetch, allowedOrigins: [API], policy }) },
    stopWhen: stepCountIs(3),
    prompt: "What is the XLM/USD price?",
  });
  return {
    text: result.text,
    toolResults: result.steps.flatMap((step) => step.toolResults.map((r) => r.output)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runAiAgent();
  for (const output of run.toolResults) console.log(JSON.stringify(output, null, 2));
  console.log(`\nModel: ${run.text}`);
}
