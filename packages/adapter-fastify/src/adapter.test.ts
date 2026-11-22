import { Ed25519Signer } from "@vegaforge/tollway-core";
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
} from "@vegaforge/tollway-server";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { fastifyPaywall, fastifyRouteTable, RECEIPT_REQUEST_KEY } from "./index.js";

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

  const app = Fastify();
  app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async (request) => {
    const receipt = request[RECEIPT_REQUEST_KEY];
    if (!receipt) throw new Error("receipt missing on request");
    return { quote: 42, receiptId: receipt.receipt.id };
  });
  await app.ready();
  return app;
}

describe("fastifyPaywall", () => {
  it("answers 402 with a challenge when payment is missing", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/quotes/latest" });

      expect(response.statusCode).toBe(402);
      const challenge = response.json<{ accepts: Array<{ amount: string }> }>();
      expect(challenge.accepts[0]?.amount).toBe("10000");
    } finally {
      await app.close();
    }
  });

  it("runs the wrapped handler and adds the PAYMENT-RESPONSE header once payment settles", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["payment-response"]).toBeTruthy();
      const body = response.json<{ quote: number; receiptId: string }>();
      expect(body.quote).toBe(42);
      expect(body.receiptId).toBeTruthy();
    } finally {
      await app.close();
    }
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
          // RouteReason is a closed union; "override" fits the intent of a
          // stub router that pins the model regardless of the offer.
          return { model: "mpp-channel", reason: "override" };
        },
      },
    });

    const app = Fastify();
    app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async () => ({ quote: 42 }));
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      });

      expect(response.statusCode).toBe(501);
      const body = response.json<{ error?: string; quote?: number }>();
      expect(body.quote).toBeUndefined();
      expect(body.error).toMatch(/mpp-channel/);
    } finally {
      await app.close();
    }
  });
});

describe("fastifyRouteTable", () => {
  it("gates paid paths and passes free paths through", async () => {
    const signer = await Ed25519Signer.generate("route-table-fastify");
    const routes = createRouteTable(
      { "GET /paid/:id": config },
      { signer, facilitator: createMockFacilitator() },
    );
    const app = Fastify();
    app.addHook("preHandler", fastifyRouteTable(routes));
    app.get("/paid/:id", async () => "paid");
    app.get("/free", async () => "free");
    await app.ready();
    try {
      expect((await app.inject({ url: "/paid/1" })).statusCode).toBe(402);
      expect((await app.inject({ url: "/free" })).body).toBe("free");
    } finally {
      await app.close();
    }
  });
});

// Regression lock for ADR-2026-11-18-method-binding.
describe("fastifyPaywall method binding", () => {
  it("does not let a payment made for GET unlock POST on the same path", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
    });
    const app = Fastify();
    app.route({
      method: ["GET", "POST"],
      url: "/report",
      preHandler: fastifyPaywall(gate),
      handler: async () => ({ ok: true }),
    });
    await app.ready();
    const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mock-signed-auth-entry-method") };
    try {
      const read = await app.inject({ method: "GET", url: "/report", headers });
      expect(read.statusCode).toBe(200);
      const write = await app.inject({ method: "POST", url: "/report", headers });
      expect(write.statusCode).toBe(409);
    } finally {
      await app.close();
    }
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

describe("fastifyPaywall with mpp-charge", () => {
  async function build() {
    const gate = await mppGate();
    const app = Fastify();
    app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async (request) => ({
      receiptModel: request[RECEIPT_REQUEST_KEY]?.receipt.model,
    }));
    await app.ready();
    return app;
  }

  it("sends the MPP challenge headers with the 402", async () => {
    const app = await build();
    try {
      const response = await app.inject({ method: "GET", url: "/quotes/latest" });
      expect(response.statusCode).toBe(402);
      expect(response.headers["www-authenticate"]).toBe('Payment id="test"');
      expect(response.headers["payment-required"]).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("settles an Authorization: Payment credential", async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: "Payment ok" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ receiptModel: string }>().receiptModel).toBe("mpp-charge");
    } finally {
      await app.close();
    }
  });

  it("answers a refused credential with the rejection status", async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: "Payment refused" },
      });
      expect(response.statusCode).toBe(402);
      expect(response.json()).toEqual({ error: "mpp challenge was not issued by this server" });
    } finally {
      await app.close();
    }
  });
});

describe("fastifyPaywall with a dynamic price", () => {
  async function buildDynamic(price: () => string) {
    const signer = await Ed25519Signer.generate("dynamic-fastify");
    const gate = createPaywall(dynamicConfig(price), {
      signer,
      facilitator: createMockFacilitator(),
    });
    const app = Fastify();
    app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async (request) => ({
      amount: request[RECEIPT_REQUEST_KEY]?.receipt.amount,
    }));
    await app.ready();
    return app;
  }

  it("settles the quoted amount from a payment built from the 402", async () => {
    const app = await buildDynamic(risingPrice());
    try {
      const challenge = await app.inject({ method: "GET", url: "/quotes/latest" });
      expect(challenge.statusCode).toBe(402);
      const header = challenge.headers[PAYMENT_REQUIRED_HEADER.toLowerCase()];
      const required = typeof header === "string" ? header : undefined;
      expect(decodePaymentRequiredHeader(required ?? "").accepts[0]?.amount).toBe("101");

      const paid = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { [PAYMENT_SIGNATURE_HEADER]: payFrom(required, "dynamic-fastify") },
      });
      expect(paid.statusCode).toBe(200);
      expect(paid.json()).toEqual({ amount: "101" });
    } finally {
      await app.close();
    }
  });

  it("answers 500 and charges nothing when the price function throws", async () => {
    const app = await buildDynamic(throwingPrice);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("dynamic-fastify-throws") },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe("fastifyPaywall with a service policy", () => {
  it("sends a 429 denial with Retry-After", async () => {
    const signer = await Ed25519Signer.generate("policy-fastify");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      servicePolicy: { spendPerWindow: { limit: "0", windowSeconds: 60 } },
      clock: () => 0,
    });
    const app = Fastify();
    app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async () => ({ quote: 42 }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("policy-fastify-payment") },
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("60");
      expect(response.json()).toEqual({ error: "service-policy:spend-exceeded" });
    } finally {
      await app.close();
    }
  });
});
