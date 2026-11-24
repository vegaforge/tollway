import { honoPaywall } from "@vegaforge/tollway-adapter-hono";
import { withPaywall } from "@vegaforge/tollway-adapter-next";
import { Ed25519Signer, Ed25519Verifier, verifyReceipt } from "@vegaforge/tollway-core";
import {
  createHttpFacilitator,
  createMockFacilitator,
  createPaywall,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import { Hono } from "hono";

/**
 * One gate scenario, the same on every runtime: an unpaid request gets 402,
 * a paid one settles through the mock facilitator and returns a receipt
 * that verifies. It runs through the Hono adapter and a Next-style
 * `withPaywall` handler, then once more through `createHttpFacilitator`
 * against a stubbed facilitator endpoint. It uses only Web APIs, so the
 * runners for workerd, Deno and Bun all call it the same way.
 */

export type StepResult = { step: string; ok: boolean; detail?: string };

const CONFIG = {
  amount: "10000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GDSERVICEEDGEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

const FACILITATOR_URL = "https://facilitator.edge.test";

function payFrom(paymentRequired: string | null, transaction: string): string {
  const accepted = decodePaymentRequiredHeader(paymentRequired ?? "").accepts[0];
  if (!accepted) throw new Error("the 402 offers no payment requirements");
  return encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transaction } });
}

async function receiptVerifies(response: Response, verifier: Ed25519Verifier): Promise<string> {
  const header = response.headers.get(TOLLWAY_RECEIPT_HEADER);
  if (!header) return "no TOLLWAY-RECEIPT header";
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(header.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    ),
  );
  const result = await verifyReceipt(JSON.parse(json), verifier);
  return result.valid ? "" : `receipt does not verify: ${result.reason}`;
}

/** Runs unpaid-then-paid against one fetch handler and reports each step. */
async function payThrough(
  label: string,
  handle: (request: Request) => Promise<Response>,
  verifier: Ed25519Verifier,
  transaction: string,
): Promise<StepResult[]> {
  const url = "https://service.edge.test/quotes/latest";
  const unpaid = await handle(new Request(url));
  const challenge = unpaid.headers.get(PAYMENT_REQUIRED_HEADER);
  const results: StepResult[] = [
    {
      step: `${label}: unpaid request gets 402`,
      ok: unpaid.status === 402 && challenge !== null,
      detail: `status ${unpaid.status}`,
    },
  ];
  const paid = await handle(
    new Request(url, { headers: { [PAYMENT_SIGNATURE_HEADER]: payFrom(challenge, transaction) } }),
  );
  const problem = paid.status === 200 ? await receiptVerifies(paid, verifier) : "";
  results.push({
    step: `${label}: paid request settles with a receipt that verifies`,
    ok: paid.status === 200 && problem === "",
    detail: problem || `status ${paid.status}`,
  });
  return results;
}

/**
 * A facilitator endpoint stubbed inside the runtime: requests to
 * FACILITATOR_URL are answered here; everything else is refused, so the
 * scenario never reaches the network.
 */
function stubFacilitatorFetch(): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!request.url.startsWith(FACILITATOR_URL)) {
      throw new TypeError(`the edge scenario does not reach ${request.url}`);
    }
    const payer = "GBPAYEREDGEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    if (path === "/verify") return Response.json({ isValid: true, payer });
    if (path === "/settle") {
      return Response.json({
        success: true,
        transaction: "a".repeat(64),
        network: "stellar:testnet",
        payer,
      });
    }
    return new Response("not found", { status: 404 });
  };
}

export async function runScenario(): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let signer: Ed25519Signer;
  try {
    signer = await Ed25519Signer.generate("edge");
    results.push({ step: "WebCrypto Ed25519 key generation", ok: true });
  } catch (error) {
    return [{ step: "WebCrypto Ed25519 key generation", ok: false, detail: String(error) }];
  }
  const verifier = Ed25519Verifier.forSigner(signer);

  const gate = createPaywall(CONFIG, { signer, facilitator: createMockFacilitator() });
  const app = new Hono();
  app.use("/quotes/*", honoPaywall(gate));
  app.get("/quotes/latest", (c) => c.json({ price: "1.00" }));
  results.push(
    ...(await payThrough("Hono", async (request) => app.fetch(request), verifier, "tx-hono")),
  );

  const nextHandler = withPaywall(gate, async () => Response.json({ price: "1.00" }));
  results.push(...(await payThrough("Next withPaywall", nextHandler, verifier, "tx-next")));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFacilitatorFetch();
  try {
    const httpGate = createPaywall(CONFIG, {
      signer,
      facilitator: createHttpFacilitator(FACILITATOR_URL),
    });
    const httpApp = new Hono();
    httpApp.use("/quotes/*", honoPaywall(httpGate));
    httpApp.get("/quotes/latest", (c) => c.json({ price: "1.00" }));
    results.push(
      ...(await payThrough(
        "createHttpFacilitator",
        async (request) => httpApp.fetch(request),
        verifier,
        "AAAAAgAAAAA=",
      )),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return results;
}

/** Prints the results and returns whether every step passed. */
export function report(runtime: string, results: StepResult[]): boolean {
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} [${runtime}] ${result.step}${result.detail ? ` (${result.detail})` : ""}`,
    );
  }
  return results.length > 0 && results.every((result) => result.ok);
}
