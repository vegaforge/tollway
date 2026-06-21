import type { PaymentOffer, X402Payment } from "@tollway/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpFacilitator } from "./facilitator.js";

const offer: PaymentOffer = {
  resource: "https://api.example.com/quotes/latest",
  amount: "10000",
  // The x402 asset is the Stellar token contract (USDC testnet SAC here).
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  models: ["x402"],
};

const payment: X402Payment = { model: "x402", paymentSignature: "AAAA-base64-stellar-tx" };

const FACILITATOR_URL = "https://facilitator.test";

type SentRequest = {
  x402Version: number;
  paymentRequirements: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  };
  paymentPayload: { x402Version: number; accepted: unknown; payload: Record<string, unknown> };
};

describe("createHttpFacilitator", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function lastCall(): [string, RequestInit] {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return call as [string, RequestInit];
  }

  function lastBody(): SentRequest {
    const [, init] = lastCall();
    return JSON.parse(init.body as string) as SentRequest;
  }

  it("posts the x402/stellar verify shape and maps a valid response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ isValid: true, payer: "GPAYER" }));

    const result = await createHttpFacilitator(FACILITATOR_URL).verify({ payment, offer });
    expect(result).toEqual({ valid: true, payer: "GPAYER", nonce: expect.any(String) });

    const [url, init] = lastCall();
    expect(url).toBe(`${FACILITATOR_URL}/verify`);
    expect(init.method).toBe("POST");

    const body = lastBody();
    expect(body.x402Version).toBe(2);
    expect(body.paymentRequirements).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      asset: offer.asset,
      amount: "10000",
      payTo: offer.payTo,
      maxTimeoutSeconds: 60,
    });
    // x402 V2 carries the base64 Stellar transaction envelope, not a bare signature.
    expect(body.paymentPayload.payload).toEqual({ transaction: payment.paymentSignature });
  });

  it("derives a stable nonce from the same payment", async () => {
    // A Response body can be read only once, so build a fresh one per call.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ isValid: true, payer: "GPAYER" })),
    );
    const facilitator = createHttpFacilitator(FACILITATOR_URL);

    const first = await facilitator.verify({ payment, offer });
    const second = await facilitator.verify({ payment, offer });
    if (!first.valid || !second.valid) throw new Error("expected both verifications to be valid");
    expect(first.nonce).toBe(second.nonce);
  });

  it("maps an invalid 200 verify response to a rejection", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ isValid: false, invalidReason: "insufficient_funds" }),
    );
    const result = await createHttpFacilitator(FACILITATOR_URL).verify({ payment, offer });
    expect(result).toEqual({ valid: false, reason: "insufficient_funds" });
  });

  it("treats a 4xx verify with an isValid:false body as a rejection, not a throw", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ isValid: false, invalidReason: "expired" }, 402),
    );
    const result = await createHttpFacilitator(FACILITATOR_URL).verify({ payment, offer });
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a valid verify response that omits the payer", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ isValid: true }));
    const result = await createHttpFacilitator(FACILITATOR_URL).verify({ payment, offer });
    expect(result).toEqual({ valid: false, reason: expect.stringContaining("no payer") });
  });

  it("maps mainnet to the pubnet CAIP-2 id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ isValid: true, payer: "GPAYER" }));
    await createHttpFacilitator(FACILITATOR_URL).verify({
      payment,
      offer: { ...offer, network: "mainnet" },
    });
    expect(lastBody().paymentRequirements.network).toBe("stellar:pubnet");
  });

  it("maps a successful settle to a tx hash", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, transaction: "TXHASH", network: "stellar:testnet" }),
    );
    const result = await createHttpFacilitator(FACILITATOR_URL).settle({
      payment,
      offer,
      payer: "GPAYER",
      nonce: "n",
    });
    expect(result).toEqual({ settled: true, txHash: "TXHASH" });
    expect(lastCall()[0]).toBe(`${FACILITATOR_URL}/settle`);
  });

  it("maps a 4xx settle with a success:false body to a reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, errorReason: "settlement_failed" }, 402),
    );
    const result = await createHttpFacilitator(FACILITATOR_URL).settle({
      payment,
      offer,
      payer: "GPAYER",
      nonce: "n",
    });
    expect(result).toEqual({ settled: false, reason: "settlement_failed" });
  });

  it("maps /supported kinds to Tollway models", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }] }),
    );
    const result = await createHttpFacilitator(FACILITATOR_URL).supported();
    expect(result).toEqual({ models: ["x402"], assets: [] });
    const [url, init] = lastCall();
    expect(url).toBe(`${FACILITATOR_URL}/supported`);
    expect(init.method).toBe("GET");
  });

  it("wraps a transport failure as a TollwayError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream boom", { status: 503 }));
    await expect(
      createHttpFacilitator(FACILITATOR_URL).verify({ payment, offer }),
    ).rejects.toMatchObject({ code: "payment-failed" });
  });
});
