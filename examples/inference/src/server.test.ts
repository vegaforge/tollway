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
  COMPLETION_PRICE,
  createInferenceService,
  DEFAULT_TESTNET_ASSET,
  DEFAULT_TESTNET_PAY_TO,
  type InferenceService,
  TESTNET_FACILITATOR_URL,
} from "./server.js";

/**
 * Smoke test in mock mode: the real Express app on a free port, called with
 * fetch the way an agent calls it. No facilitator and no Stellar network.
 */

let service: InferenceService;
let server: Server;
let url: string;

beforeAll(async () => {
  service = await createInferenceService({ TOLLWAY_MODE: "mock" });
  server = service.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/complete`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function ask(prompt: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ prompt }),
  });
}

describe("POST /complete", () => {
  it("answers an unpaid request with 402 and the challenge header", async () => {
    const response = await ask("What does a receipt prove?");

    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.accepts[0]).toMatchObject({
      amount: COMPLETION_PRICE,
      asset: DEFAULT_TESTNET_ASSET,
      payTo: DEFAULT_TESTNET_PAY_TO,
      network: "stellar:testnet",
    });
  });

  it("serves a mock-paid request with a completion and a receipt that verifies", async () => {
    const challenged = await ask("What does a receipt prove?");
    const challenge = decodePaymentRequiredHeader(
      challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    const [requirements] = challenge.accepts;
    if (!requirements) {
      throw new Error("the 402 challenge lists no payment options");
    }

    // The agent pays for exactly what the challenge asks and retries. In mock
    // mode a fixed transaction stands in for the signed authorization entry.
    const paid = await ask("What does a receipt prove?", {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "mock-signed-auth-entry" },
      }),
    });

    expect(paid.status).toBe(200);
    const body = (await paid.json()) as { completion: string; receiptId: string };
    expect(body.completion).toContain("canned completion");

    const receipt = decodeHeader<SignedReceipt>(paid.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
    expect(receipt.receipt.id).toBe(body.receiptId);
    expect(receipt.receipt.amount).toBe(COMPLETION_PRICE);
    await expect(
      verifyReceipt(receipt, Ed25519Verifier.forSigner(service.signer)),
    ).resolves.toMatchObject({ valid: true });
  });

  it("refuses a request without a prompt before asking for payment", async () => {
    const response = await ask("");

    expect(response.status).toBe(400);
    expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
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

    const testnet = await createInferenceService({ TOLLWAY_MODE: "testnet", OZ_API_KEY: "k" });
    const listening = testnet.app.listen(0);
    await new Promise((resolve) => listening.once("listening", resolve));
    const target = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/complete`;
    try {
      const challenged = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });
      const [requirements] = decodePaymentRequiredHeader(
        challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
      ).accepts;
      if (!requirements) {
        throw new Error("the 402 challenge lists no payment options");
      }
      const paid = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: requirements,
            payload: { transaction: "AAAAAgAAAAB0ZXN0LXRyYW5zYWN0aW9u" },
          }),
        },
        body: JSON.stringify({ prompt: "hello" }),
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
    await expect(createInferenceService({ TOLLWAY_MODE: "testnet" })).rejects.toMatchObject({
      name: "ExampleConfigError",
      problems: [expect.stringContaining("OZ_API_KEY")],
    });
  });
});
