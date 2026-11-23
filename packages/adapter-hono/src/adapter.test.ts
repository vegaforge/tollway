import {
  buildReceipt,
  createKeySetVerifier,
  Ed25519Signer,
  signReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createMockMppChargeHandler,
  createPaywall,
  createRouteTable,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  type MppChargeHandler,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
  renderKeySetResponse,
} from "@vegaforge/tollway-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { honoPaywall, honoRouteTable, RECEIPT_CONTEXT_KEY } from "./index.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
} satisfies PaywallConfig;

/**
 * A dynamic-price route: every call to the price function returns a higher
 * price, so a paid request that re-priced instead of using its quote would
 * settle a different amount than the 402 named.
 */
function dynamicConfig(price: () => string) {
  return {
    ...config,
    amount: price,
    minAmount: "1",
    maxAmount: "100000",
    quoteSecret: "adapter test quote secret",
  } satisfies PaywallConfig;
}

function risingPrice(): () => string {
  let calls = 0;
  return () => String(100 + ++calls);
}

/** Pays a 402 the way a stock x402 V2 client does: `accepts[0]` becomes `accepted`. */
function payFrom(paymentRequired: string | null | undefined, transaction: string): string {
  const accepted = decodePaymentRequiredHeader(paymentRequired ?? "").accepts[0];
  if (!accepted) throw new Error("the 402 offers no payment requirements");
  return encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transaction } });
}

const throwingPrice = (): string => {
  throw new Error("pricing backend down");
};

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

async function buildApp() {
  const signer = await Ed25519Signer.generate("test-key");
  const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });

  const app = new Hono();
  app.get("/quotes/latest", honoPaywall(gate), (c) => {
    const signed = c.get(RECEIPT_CONTEXT_KEY);
    return c.json({ quote: 42, receiptId: signed.receipt.id });
  });
  return app;
}

describe("honoPaywall", () => {
  it("answers 402 with a challenge when payment is missing", async () => {
    const app = await buildApp();
    const response = await app.request("/quotes/latest");

    expect(response.status).toBe(402);
    const challenge = (await response.json()) as { accepts: Array<{ amount: string }> };
    expect(challenge.accepts[0]?.amount).toBe("10000");
  });

  it("serves the resource once a valid payment is supplied", async () => {
    const app = await buildApp();
    const response = await app.request("/quotes/latest", {
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    const body = (await response.json()) as { quote: number; receiptId: string };
    expect(body.quote).toBe(42);
    expect(body.receiptId).toBeTruthy();
  });
});

describe("honoRouteTable", () => {
  it("gates paid paths and passes free paths through", async () => {
    const signer = await Ed25519Signer.generate("route-table-hono");
    const routes = createRouteTable(
      { "GET /paid/:id": config },
      { signer, facilitator: createMockFacilitator() },
    );
    const app = new Hono();
    app.use("*", honoRouteTable(routes));
    app.get("/paid/:id", (c) => c.text("paid"));
    app.get("/free", (c) => c.text("free"));
    expect((await app.request("/paid/1")).status).toBe(402);
    expect(await (await app.request("/free")).text()).toBe("free");
  });
});

// Regression lock for ADR-2026-11-18-method-binding.
describe("honoPaywall method binding", () => {
  it("does not let a payment made for GET unlock POST on the same path", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
    });
    const app = new Hono();
    app.on(["GET", "POST"], "/report", honoPaywall(gate), (c) => c.json({ ok: true }));
    const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mock-signed-auth-entry-method") };

    const read = await app.request("/report", { headers });
    expect(read.status).toBe(200);
    const write = await app.request("/report", { method: "POST", headers });
    expect(write.status).toBe(409);
  });
});

// MPP charge through the adapter: the challenge headers reach the client on
// the 402, an Authorization: Payment credential settles, and a refused
// credential comes back as the rejection status.
async function mppGate() {
  const signer = await Ed25519Signer.generate("test-key-mpp");
  const base = createMockMppChargeHandler();
  const handler: MppChargeHandler = {
    ...base,
    async challenge() {
      return {
        status: 402,
        headers: { "www-authenticate": 'Payment id="test"', "cache-control": "no-store" },
        body: null,
      };
    },
    async verify(input) {
      if (input.payment.payload === "Payment refused") {
        return { valid: false, reason: "mpp challenge was not issued by this server" };
      }
      return base.verify(input);
    },
  };
  return createPaywall(
    { ...config, models: ["x402", "mpp-charge"] },
    { signer, facilitator: createMockFacilitator(), mppChargeHandler: handler },
  );
}

describe("honoPaywall with mpp-charge", () => {
  async function build() {
    const gate = await mppGate();
    const app = new Hono();
    app.get("/quotes/latest", honoPaywall(gate), (c) =>
      c.json({ receiptModel: c.get(RECEIPT_CONTEXT_KEY).receipt.model }),
    );
    return app;
  }

  it("sends the MPP challenge headers with the 402", async () => {
    const response = await (await build()).request("/quotes/latest");
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toBe('Payment id="test"');
    expect(response.headers.get("payment-required")).toBeTruthy();
  });

  it("settles an Authorization: Payment credential", async () => {
    const response = await (await build()).request("/quotes/latest", {
      headers: { authorization: "Payment ok" },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { receiptModel: string }).receiptModel).toBe("mpp-charge");
  });

  it("answers a refused credential with the rejection status", async () => {
    const response = await (await build()).request("/quotes/latest", {
      headers: { authorization: "Payment refused" },
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "mpp challenge was not issued by this server" });
  });
});

describe("honoPaywall with a dynamic price", () => {
  async function buildDynamic(price: () => string) {
    const signer = await Ed25519Signer.generate("dynamic-hono");
    const gate = createPaywall(dynamicConfig(price), {
      signer,
      facilitator: createMockFacilitator(),
    });
    const app = new Hono();
    app.get("/quotes/latest", honoPaywall(gate), (c) =>
      c.json({ amount: c.get(RECEIPT_CONTEXT_KEY).receipt.amount }),
    );
    return app;
  }

  it("settles the quoted amount from a payment built from the 402", async () => {
    const app = await buildDynamic(risingPrice());
    const challenge = await app.request("/quotes/latest");
    expect(challenge.status).toBe(402);
    const header = challenge.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(decodePaymentRequiredHeader(header ?? "").accepts[0]?.amount).toBe("101");

    const paid = await app.request("/quotes/latest", {
      headers: { [PAYMENT_SIGNATURE_HEADER]: payFrom(header, "dynamic-hono") },
    });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ amount: "101" });
  });

  it("answers 500 and charges nothing when the price function throws", async () => {
    const app = await buildDynamic(throwingPrice);
    const response = await app.request("/quotes/latest", {
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("dynamic-hono-throws") },
    });
    expect(response.status).toBe(500);
  });
});

describe("honoPaywall with a service policy", () => {
  it("sends a 429 denial with Retry-After", async () => {
    const signer = await Ed25519Signer.generate("policy-hono");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      servicePolicy: { spendPerWindow: { limit: "0", windowSeconds: 60 } },
      clock: () => 0,
    });
    const app = new Hono();
    app.get("/quotes/latest", honoPaywall(gate), (c) => c.json({ quote: 42 }));

    const response = await app.request("/quotes/latest", {
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("policy-hono-payment") },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "service-policy:spend-exceeded" });
  });
});

describe("serving the receipt key set (#167)", () => {
  it("mounts renderKeySetResponse at the well-known path and a key-set verifier reads it", async () => {
    const signer = await Ed25519Signer.generate("service-key-1");
    const app = new Hono();
    app.get("/.well-known/tollway-receipt-keys.jwks", (c) => {
      const response = renderKeySetResponse(
        { keys: [{ ...signer.publicJwk(), status: { state: "active" } }] },
        { maxAgeSeconds: 120 },
      );
      return c.body(response.body, response.status, response.headers);
    });

    const served = await app.request("/.well-known/tollway-receipt-keys.jwks");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/jwk-set+json");
    expect(served.headers.get("cache-control")).toBe("public, max-age=120");

    const verifier = createKeySetVerifier({
      url: "https://service.example/.well-known/tollway-receipt-keys.jwks",
      fetch: async (url) => app.request(new URL(url).pathname),
    });
    const receipt = await signReceipt(
      buildReceipt({
        payer: "GPAYER",
        payee: "GSERVICE",
        amount: "10000",
        asset: "USDC:GA5Z",
        resource: "/quotes/latest",
        model: "x402",
        settlement: { kind: "transaction", txHash: "tx" },
        network: "testnet",
      }),
      signer,
    );
    await expect(verifyReceipt(receipt, verifier)).resolves.toMatchObject({ valid: true });
  });
});
