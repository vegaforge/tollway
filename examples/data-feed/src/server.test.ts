import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Ed25519Verifier, type SignedReceipt, verifyReceipt } from "@vegaforge/tollway-core";
import {
  decodeHeader,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDataFeedService,
  type DataFeedService,
  DEFAULT_TESTNET_ASSET,
  DEFAULT_TESTNET_PAY_TO,
  FEED_PRICE,
  TESTNET_FACILITATOR_URL,
} from "./server.js";

/**
 * Smoke test in mock mode: the real Express app on a free port, called with
 * fetch the way an agent calls it. No facilitator and no Stellar network.
 */

let service: DataFeedService;
let server: Server;
let url: string;

beforeAll(async () => {
  service = await createDataFeedService({ TOLLWAY_MODE: "mock" });
  server = service.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("GET /feed", () => {
  it("answers an unpaid request with 402 and the challenge header", async () => {
    const response = await fetch(url);

    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.accepts[0]).toMatchObject({
      amount: FEED_PRICE,
      asset: DEFAULT_TESTNET_ASSET,
      payTo: DEFAULT_TESTNET_PAY_TO,
      network: "stellar:testnet",
    });
  });

  it("serves a mock-paid request with the feed and a receipt that verifies", async () => {
    const challenged = await fetch(url);
    const challenge = decodePaymentRequiredHeader(
      challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    const [requirements] = challenge.accepts;
    if (!requirements) {
      throw new Error("the 402 challenge lists no payment options");
    }

    // The agent pays for exactly what the challenge asks and retries. In mock
    // mode a fixed transaction stands in for the signed authorization entry.
    const paid = await fetch(url, {
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { transaction: "mock-signed-auth-entry" },
        }),
      },
    });

    expect(paid.status).toBe(200);
    const body = (await paid.json()) as { ticks: unknown[]; receiptId: string };
    expect(body.ticks).toHaveLength(3);

    const receipt = decodeHeader<SignedReceipt>(paid.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
    expect(receipt.receipt.id).toBe(body.receiptId);
    expect(receipt.receipt.amount).toBe(FEED_PRICE);
    await expect(
      verifyReceipt(receipt, Ed25519Verifier.forSigner(service.signer)),
    ).resolves.toMatchObject({ valid: true });
  });
});

describe("defaults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are a valid testnet account and the testnet USDC contract", () => {
    expect(StrKey.isValidEd25519PublicKey(DEFAULT_TESTNET_PAY_TO)).toBe(true);
    expect(StrKey.isValidContract(DEFAULT_TESTNET_ASSET)).toBe(true);
  });

  it("settle through the OpenZeppelin Channels testnet facilitator with the API key", async () => {
    // The facilitator is stubbed and recorded; requests to the local service
    // go through the real fetch. No Stellar network is involved.
    const payer = Keypair.random().publicKey();
    const realFetch = globalThis.fetch;
    const facilitatorCalls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : input.toString();
      if (target.startsWith("http://127.0.0.1:")) {
        return realFetch(input, init);
      }
      facilitatorCalls.push({
        url: target,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      const body = target.endsWith("/verify")
        ? { isValid: true, payer }
        : { success: true, transaction: "a".repeat(64), network: "stellar:testnet", payer };
      return Response.json(body);
    });

    const testnet = await createDataFeedService({ TOLLWAY_MODE: "testnet", OZ_API_KEY: "k" });
    const listening = testnet.app.listen(0);
    await new Promise((resolve) => listening.once("listening", resolve));
    const target = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/feed`;
    try {
      const challenged = await fetch(target);
      const [requirements] = decodePaymentRequiredHeader(
        challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
      ).accepts;
      if (!requirements) {
        throw new Error("the 402 challenge lists no payment options");
      }
      const paid = await fetch(target, {
        headers: {
          [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: requirements,
            payload: { transaction: "AAAAAgAAAAB0ZXN0LXRyYW5zYWN0aW9u" },
          }),
        },
      });

      expect(paid.status).toBe(200);
      expect(facilitatorCalls.length).toBeGreaterThan(0);
      for (const call of facilitatorCalls) {
        expect(call.url.startsWith(`${TESTNET_FACILITATOR_URL}/`)).toBe(true);
        expect(call.authorization).toBe("Bearer k");
      }
    } finally {
      await new Promise((resolve) => listening.close(resolve));
    }
  });

  it("need an OpenZeppelin Channels API key on testnet", async () => {
    await expect(createDataFeedService({ TOLLWAY_MODE: "testnet" })).rejects.toMatchObject({
      name: "ExampleConfigError",
      problems: [expect.stringContaining("OZ_API_KEY")],
    });
  });
});
