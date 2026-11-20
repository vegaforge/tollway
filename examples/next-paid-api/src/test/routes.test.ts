import { Ed25519Verifier, type SignedReceipt, verifyReceipt } from "@vegaforge/tollway-core";
import {
  decodeHeader,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as quote } from "../app/api/quote/route";
import { GET as receiptKey } from "../app/api/receipt-key/route";
import { POST as summarize } from "../app/api/summarize/route";
import { getServices, QUOTE_PRICE, SUMMARIZE_PRICE } from "../lib/services";

/**
 * Smoke test in mock mode: the route handlers are called directly with
 * Requests, exactly as Next.js calls them, with no server and no network.
 */

const BASE = "http://example.test";

async function publishedVerifier(): Promise<Ed25519Verifier> {
  const body = (await (await receiptKey()).json()) as { keyId: string; publicKey: string };
  return new Ed25519Verifier({ [body.keyId]: body.publicKey });
}

/** A standard-base64 x402 V2 payment header, as a stock client writes it. */
function paymentHeader(transaction: string): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "10000",
      payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction },
  });
}

function receiptOf(response: Response): SignedReceipt {
  return decodeHeader<SignedReceipt>(response.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
}

beforeAll(() => {
  vi.stubEnv("TOLLWAY_MODE", "mock");
  vi.stubEnv("TOLLWAY_DEPLOYED", "false");
  vi.stubEnv("TOLLWAY_RECEIPT_KEY", "");
  vi.stubEnv("REDIS_URL", "");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/quote", () => {
  it("answers an unpaid request with 402 and the challenge header", async () => {
    const response = await quote(new Request(`${BASE}/api/quote`));
    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.accepts[0]?.amount).toBe(QUOTE_PRICE);
  });

  it("serves a paid request with a receipt that verifies against the published key", async () => {
    const response = await quote(
      new Request(`${BASE}/api/quote`, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("quote-pay-1") },
      }),
    );
    expect(response.status).toBe(200);
    const receipt = receiptOf(response);
    expect(receipt.receipt.amount).toBe(QUOTE_PRICE);
    await expect(verifyReceipt(receipt, await publishedVerifier())).resolves.toMatchObject({
      valid: true,
    });
  });

  it("serves a replayed payment from the cache without settling it again", async () => {
    const { facilitator } = await getServices();
    const settle = vi.spyOn(facilitator, "settle");
    const paid = () =>
      quote(
        new Request(`${BASE}/api/quote`, {
          headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("quote-pay-replayed") },
        }),
      );
    const first = await paid();
    const second = await paid();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(receiptOf(second).receipt.id).toBe(receiptOf(first).receipt.id);
    settle.mockRestore();
  });
});

describe("POST /api/summarize", () => {
  it("charges its own price and still reads the body after the gate", async () => {
    const unpaid = await summarize(
      new Request(`${BASE}/api/summarize`, {
        method: "POST",
        body: JSON.stringify({ text: "One. Two." }),
      }),
    );
    expect(unpaid.status).toBe(402);
    expect(
      decodePaymentRequiredHeader(unpaid.headers.get(PAYMENT_REQUIRED_HEADER) ?? "").accepts[0]
        ?.amount,
    ).toBe(SUMMARIZE_PRICE);

    const paid = await summarize(
      new Request(`${BASE}/api/summarize`, {
        method: "POST",
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("summarize-pay-1") },
        body: JSON.stringify({ text: "Tollway charges agents. It settles on Stellar." }),
      }),
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ summary: "Tollway charges agents." });
    await expect(verifyReceipt(receiptOf(paid), await publishedVerifier())).resolves.toMatchObject({
      valid: true,
    });
  });

  it("refuses a malformed body before the gate, without settling", async () => {
    const { facilitator } = await getServices();
    const settle = vi.spyOn(facilitator, "settle");
    const response = await summarize(
      new Request(`${BASE}/api/summarize`, {
        method: "POST",
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("summarize-pay-bad-body") },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
    expect(settle).not.toHaveBeenCalled();
    settle.mockRestore();
  });
});
