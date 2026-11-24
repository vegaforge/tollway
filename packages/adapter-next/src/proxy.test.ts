import {
  Ed25519Signer,
  Ed25519Verifier,
  TollwayError,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  createMockFacilitator,
  createPaywall,
  encodePaymentSignatureHeader,
  type Gate,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@vegaforge/tollway-server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProxyRuntime,
  getProxyReceipt,
  PROXY_RECEIPT_HEADER,
  paywallProxy,
} from "./proxy.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
} satisfies PaywallConfig;

/** A standard-base64 x402 V2 payment header, as a stock client writes it. */
function paymentHeader(transaction = "mock-signed-auth-entry"): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: config.asset,
      amount: config.amount,
      payTo: config.payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction },
  });
}

afterEach(() => vi.unstubAllEnvs());

async function build() {
  const signer = await Ed25519Signer.generate("proxy-test-key");
  const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });
  return { signer, gate, proxy: paywallProxy({ routes: [{ path: "/api/paid", gate }] }) };
}

describe("paywallProxy", () => {
  it("answers 402 with the gate challenge for a matched path", async () => {
    const { proxy } = await build();
    const response = await proxy(new NextRequest("https://example.test/api/paid/item"));

    expect(response.status).toBe(402);
    expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
  });

  it("passes unmatched paths through", async () => {
    const { proxy } = await build();
    const response = await proxy(new NextRequest("https://example.test/api/free"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get(PROXY_RECEIPT_HEADER)).toBeNull();
  });

  it("strips a caller receipt header and forwards the gate receipt only upstream", async () => {
    const { signer, gate } = await build();
    let gateHeaders: Record<string, string | string[] | undefined> | undefined;
    const inspectingGate: Gate = async (request) => {
      gateHeaders = request.headers;
      return gate(request);
    };
    const proxy = paywallProxy({ routes: [{ path: "/api/paid", gate: inspectingGate }] });
    const response = await proxy(
      new NextRequest("https://example.test/api/paid", {
        headers: {
          [PAYMENT_SIGNATURE_HEADER]: paymentHeader(),
          [PROXY_RECEIPT_HEADER]: "caller-forgery",
        },
      }),
    );

    expect(gateHeaders?.[PROXY_RECEIPT_HEADER]).toBeUndefined();
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy();
    expect(response.headers.get(PROXY_RECEIPT_HEADER)).toBeNull();
    const forwardedName = `x-middleware-request-${PROXY_RECEIPT_HEADER}`;
    const forwardedValue = response.headers.get(forwardedName);
    expect(forwardedValue).toBeTruthy();
    const receipt = getProxyReceipt(
      new Request("https://example.test/api/paid", {
        headers: { [PROXY_RECEIPT_HEADER]: forwardedValue ?? "" },
      }),
    );
    expect(receipt).toBeDefined();
    await expect(verifyReceipt(receipt, Ed25519Verifier.forSigner(signer))).resolves.toMatchObject({
      valid: true,
    });
  });

  it("answers a gate rejection without continuing to the route", async () => {
    const gate: Gate = async () => ({
      kind: "rejected",
      status: 409,
      code: "offer-mismatch",
      reason: "invalid payment",
    });
    const proxy = paywallProxy({ routes: [{ path: "/api/paid", gate }] });
    const response = await proxy(
      new NextRequest("https://example.test/api/paid", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: "bad-payment" },
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("selects the longest matching path prefix and respects configured methods", async () => {
    const seen: string[] = [];
    const gate =
      (name: string): Gate =>
      async () => {
        seen.push(name);
        return { kind: "rejected", status: 409, code: "offer-mismatch", reason: name };
      };
    const proxy = paywallProxy({
      routes: [
        { path: "/api", gate: gate("broad") },
        { path: "/api/paid", gate: gate("specific"), methods: ["POST"] },
      ],
    });
    await proxy(new NextRequest("https://example.test/api/paid/item", { method: "POST" }));
    await proxy(new NextRequest("https://example.test/api/paid/item", { method: "GET" }));
    expect(seen).toEqual(["specific", "broad"]);
  });
});

describe("getProxyReceipt", () => {
  it("returns undefined when the proxy did not attach a receipt", () => {
    expect(getProxyReceipt(new Request("https://example.test/api/paid"))).toBeUndefined();
  });

  it("rejects malformed or schema-invalid forwarded values", () => {
    expect(() =>
      getProxyReceipt(
        new Request("https://example.test", { headers: { [PROXY_RECEIPT_HEADER]: "%" } }),
      ),
    ).toThrow(TollwayError);
    expect(() =>
      getProxyReceipt(
        new Request("https://example.test", { headers: { [PROXY_RECEIPT_HEADER]: "e30" } }),
      ),
    ).toThrow(TollwayError);
    expect(() =>
      getProxyReceipt(
        new Request("https://example.test", {
          headers: { [PROXY_RECEIPT_HEADER]: "a".repeat(65_537) },
        }),
      ),
    ).toThrow(/64 KiB limit/);
  });
});

describe("paywallProxy runtime", () => {
  it("requires the Node.js runtime used by Next 16 Proxy", () => {
    expect(() => assertProxyRuntime("nodejs")).not.toThrow();
    expect(() => assertProxyRuntime("edge")).toThrow(/requires the Next.js Node.js runtime/);
  });

  it("refuses requests running in an unsupported runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { proxy } = await build();
    await expect(proxy(new NextRequest("https://example.test/api/paid"))).rejects.toThrow(
      /requires the Next.js Node.js runtime/,
    );
  });
});

// Route paths are public configuration input; normalising them must not use a
// backtracking regex (CodeQL js/polynomial-redos).
describe("paywallProxy route path normalization cost", () => {
  it("normalizes a configured path with a long run of slashes in linear time", async () => {
    const { gate } = await build();
    const started = performance.now();
    paywallProxy({ routes: [{ path: `/api${"/".repeat(50_000)}x`, gate }] });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
