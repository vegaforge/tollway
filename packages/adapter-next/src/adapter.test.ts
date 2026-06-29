import { Ed25519Signer } from "@tollway/core";
import {
  createMockFacilitator,
  createPaywall,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@tollway/server";
import { describe, expect, it } from "vitest";
import { withPaywall } from "./index.js";

const config: PaywallConfig = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
};

async function buildHandler() {
  const signer = await Ed25519Signer.generate("test-key");
  const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });
  return withPaywall(gate, async (_request, { receipt }) => {
    return Response.json({ quote: 42, receiptId: receipt.receipt.id });
  });
}

describe("withPaywall", () => {
  it("answers 402 with a challenge when payment is missing", async () => {
    const handler = await buildHandler();
    const response = await handler(new Request("http://example.test/quotes/latest"));

    expect(response.status).toBe(402);
    const challenge = (await response.json()) as { amount: string };
    expect(challenge.amount).toBe("10000");
  });

  it("runs the wrapped handler and adds the PAYMENT-RESPONSE header once payment settles", async () => {
    const handler = await buildHandler();
    const response = await handler(
      new Request("http://example.test/quotes/latest", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    const body = (await response.json()) as { quote: number; receiptId: string };
    expect(body.quote).toBe(42);
    expect(body.receiptId).toBeTruthy();
  });

  it("answers the rejection status when the gate rejects the payment", async () => {
    // Force a rejected outcome by routing to a non-x402 model the gate has
    // not implemented yet; the gate returns kind="rejected" with status 501.
    const signer = await Ed25519Signer.generate("test-key-reject");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      router: {
        async decide() {
          return { model: "mpp-channel", reason: "force-reject" };
        },
      },
    });
    const handler = withPaywall(gate, async () => Response.json({ quote: 42 }));

    const response = await handler(
      new Request("http://example.test/quotes/latest", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
      }),
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as { error?: string; quote?: number };
    expect(body.quote).toBeUndefined();
    expect(body.error).toMatch(/mpp-channel/);
  });
});
