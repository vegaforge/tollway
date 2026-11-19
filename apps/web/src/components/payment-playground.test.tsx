import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Ed25519Signer, buildReceipt, signReceipt, bytesToBase64Url } from "@vegaforge/tollway-core";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentPlayground } from "./payment-playground";
import { decodeHeaderValue, MAX_HEADER_LENGTH } from "@/lib/playground";

describe("header decoder", () => {
  it("rejects malformed input, wrong header shapes and oversized values", () => {
    expect(decodeHeaderValue("PAYMENT-REQUIRED", "not-a-header").valid).toBe(false);
    expect(decodeHeaderValue("PAYMENT-REQUIRED", JSON.stringify({ wrong: true })).valid).toBe(false);
    expect(decodeHeaderValue("PAYMENT-REQUIRED", "x".repeat(MAX_HEADER_LENGTH + 1)).errors[0]).toMatch(/limited to/);
  });
});

describe("PaymentPlayground", () => {
  it("decodes a PAYMENT-REQUIRED header using the x402 helper", () => {
    const challenge = {
      x402Version: 2,
      resource: { url: "https://api.example.test/quote", description: "quote", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "stellar:testnet", amount: "10000", asset: "USDC", payTo: "GABC", maxTimeoutSeconds: 300 }],
    };
    render(<PaymentPlayground />);
    fireEvent.change(screen.getByLabelText("Header value"), {
      target: { value: encodePaymentRequiredHeader(challenge as never) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Decode header" }));
    expect(screen.getByText(/x402 PaymentRequired v2/)).toBeTruthy();
    expect(screen.getByText("Validation passed")).toBeTruthy();
  });

  it("verifies a Tollway receipt in the browser without making network requests", async () => {
    const signer = await Ed25519Signer.generate("playground-test-key");
    const body = buildReceipt({
      payer: "GCLIENT",
      payee: "GSERVICE",
      amount: "100",
      asset: "USDC",
      resource: "/api/quote",
      model: "x402",
      settlement: { kind: "transaction", txHash: "test-transaction" },
      network: "testnet",
    });
    const receipt = await signReceipt(body, signer);
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchSpy });
    try {
      render(<PaymentPlayground />);
      fireEvent.change(screen.getByLabelText("Header type"), { target: { value: "TOLLWAY-RECEIPT" } });
      fireEvent.change(screen.getByLabelText("Header value"), {
        target: { value: bytesToBase64Url(new TextEncoder().encode(JSON.stringify(receipt))) },
      });
      fireEvent.click(screen.getByRole("button", { name: "Decode header" }));
      fireEvent.change(screen.getByLabelText("Public key or JWKS JSON"), {
        target: { value: bytesToBase64Url(signer.publicKey) },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
      expect(await screen.findByText(new RegExp("Valid signature for key " + receipt.signature.keyId))).toBeTruthy();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });
});
