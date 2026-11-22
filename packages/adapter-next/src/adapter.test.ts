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
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withPaywall, withRouteTable } from "./index.js";

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
    const challenge = (await response.json()) as { accepts: Array<{ amount: string }> };
    expect(challenge.accepts[0]?.amount).toBe("10000");
  });

  it("runs the wrapped handler and adds the PAYMENT-RESPONSE header once payment settles", async () => {
    const handler = await buildHandler();
    const response = await handler(
      new Request("http://example.test/quotes/latest", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
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
          // RouteReason is a closed union; "override" fits the intent of a
          // stub router that pins the model regardless of the offer.
          return { model: "mpp-channel", reason: "override" };
        },
      },
    });
    const handler = withPaywall(gate, async () => Response.json({ quote: 42 }));

    const response = await handler(
      new Request("http://example.test/quotes/latest", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      }),
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as { error?: string; quote?: number };
    expect(body.quote).toBeUndefined();
    expect(body.error).toMatch(/mpp-channel/);
  });
});

describe("withRouteTable", () => {
  it("gates paid paths and runs free paths directly", async () => {
    const signer = await Ed25519Signer.generate("route-table-next");
    const routes = createRouteTable(
      { "GET /paid/:id": config },
      { signer, facilitator: createMockFacilitator() },
    );
    const handler = withRouteTable(routes, async (_request, { receipt }) =>
      Response.json({ paid: Boolean(receipt) }),
    );
    expect((await handler(new Request("http://example.test/paid/1"))).status).toBe(402);
    expect(await (await handler(new Request("http://example.test/free"))).json()).toEqual({
      paid: false,
    });
  });
});

// Regression lock for ADR-2026-11-18-method-binding.
describe("withPaywall method binding", () => {
  it("does not let a payment made for GET unlock POST on the same path", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
    });
    // One route file exporting GET and POST with the same gate.
    const handler = withPaywall(gate, async () => Response.json({ ok: true }));
    const GET = handler;
    const POST = handler;
    const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mock-signed-auth-entry-method") };

    const read = await GET(new Request("http://example.test/report", { headers }));
    expect(read.status).toBe(200);
    const write = await POST(
      new Request("http://example.test/report", { method: "POST", headers }),
    );
    expect(write.status).toBe(409);
  });
});

// App Router handlers receive a NextRequest, not a plain Request. Run the
// wrapper against the real class from the Next version in the peer range.
describe("withPaywall with a real NextRequest", () => {
  it("challenges and then serves a NextRequest exactly like a Request", async () => {
    const handler = await buildHandler();

    const unpaid = await handler(new NextRequest("http://example.test/quotes/latest"));
    expect(unpaid.status).toBe(402);

    const paid = await handler(
      new NextRequest("http://example.test/quotes/latest", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      }),
    );
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBeTruthy();
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

describe("withPaywall with mpp-charge", () => {
  async function build() {
    const gate = await mppGate();
    return withPaywall(gate, async (_request, { receipt }) =>
      Response.json({ receiptModel: receipt.receipt.model }),
    );
  }
  const url = "http://example.test/quotes/latest";

  it("sends the MPP challenge headers with the 402", async () => {
    const response = await (await build())(new Request(url));
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toBe('Payment id="test"');
    expect(response.headers.get("payment-required")).toBeTruthy();
  });

  it("settles an Authorization: Payment credential", async () => {
    const response = await (await build())(
      new Request(url, { headers: { authorization: "Payment ok" } }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { receiptModel: string }).receiptModel).toBe("mpp-charge");
  });

  it("answers a refused credential with the rejection status", async () => {
    const response = await (await build())(
      new Request(url, { headers: { authorization: "Payment refused" } }),
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "mpp challenge was not issued by this server" });
  });
});

describe("withPaywall with a dynamic price", () => {
  const dynamicUrl = "http://example.test/quotes/latest";

  async function buildDynamic(price: () => string) {
    const signer = await Ed25519Signer.generate("dynamic-next");
    const gate = createPaywall(dynamicConfig(price), {
      signer,
      facilitator: createMockFacilitator(),
    });
    return withPaywall(gate, async (_request, { receipt }) =>
      Response.json({ amount: receipt.receipt.amount }),
    );
  }

  it("settles the quoted amount from a payment built from the 402", async () => {
    const handler = await buildDynamic(risingPrice());
    const challenge = await handler(new Request(dynamicUrl));
    expect(challenge.status).toBe(402);
    const header = challenge.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(decodePaymentRequiredHeader(header ?? "").accepts[0]?.amount).toBe("101");

    const paid = await handler(
      new Request(dynamicUrl, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: payFrom(header, "dynamic-next") },
      }),
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ amount: "101" });
  });

  it("answers 500 and charges nothing when the price function throws", async () => {
    const handler = await buildDynamic(throwingPrice);
    const response = await handler(
      new Request(dynamicUrl, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("dynamic-next-throws") },
      }),
    );
    expect(response.status).toBe(500);
  });
});

describe("withPaywall with a service policy", () => {
  it("sends a 429 denial with Retry-After", async () => {
    const signer = await Ed25519Signer.generate("policy-next");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      servicePolicy: { spendPerWindow: { limit: "0", windowSeconds: 60 } },
      clock: () => 0,
    });
    const handler = withPaywall(gate, async () => Response.json({ quote: 42 }));

    const response = await handler(
      new Request("http://example.test/quotes/latest", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("policy-next-payment") },
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "service-policy:spend-exceeded" });
  });
});
