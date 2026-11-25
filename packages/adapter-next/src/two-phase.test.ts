/**
 * Two-phase settlement through the Next.js App Router adapter (#152): the
 * handler runs before the payment settles, and a handler that fails is never
 * charged. Every case checks how many times the facilitator's /settle was
 * called.
 */

import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  createRouteTable,
  encodePaymentSignatureHeader,
  type FacilitatorClient,
  type Gate,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@vegaforge/tollway-server";
import { beforeAll, describe, expect, it } from "vitest";
import { type AfterHandlerPaidHandler, withPaywall, withRouteTable } from "./index.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
  twoPhase: { maxResponseBytes: 64 },
} satisfies PaywallConfig;

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

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("two-phase-next");
});

function facilitator(refuse = false) {
  const inner = createMockFacilitator();
  const calls = { settle: 0 };
  const client: FacilitatorClient = {
    ...inner,
    async settle(input) {
      calls.settle += 1;
      return refuse ? { settled: false, reason: "tx failed" } : inner.settle(input);
    },
  };
  return { client, calls };
}

function makeRoute(handler: AfterHandlerPaidHandler, options: { refuse?: boolean } = {}) {
  const { client, calls } = facilitator(options.refuse);
  const gate = createPaywall(config, {
    signer,
    facilitator: client,
    cache: createInMemorySettlementCache(),
  });
  const GET = withPaywall(gate, handler, { settlement: "after-handler" });
  return { GET, calls };
}

function paidRequest(path = "/paid"): Request {
  return new Request(`https://example.test${path}`, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
  });
}

/** A body streamed in `count` chunks of ten bytes. */
function streamed(count: number): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode("0123456789");
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
}

describe("withPaywall with settlement: after-handler", () => {
  it("settles after a successful handler and sends its response with the payment headers", async () => {
    const { GET, calls } = makeRoute(async () => Response.json({ quote: 42 }));

    const response = await GET(paidRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(response.headers.get("tollway-receipt")).toBeTruthy();
    expect(await response.json()).toEqual({ quote: 42 });
    expect(calls.settle).toBe(1);
  });

  it("never settles when the handler throws, and rethrows its error", async () => {
    const { GET, calls } = makeRoute(async () => {
      throw new Error("model overloaded");
    });

    await expect(GET(paidRequest())).rejects.toThrow("model overloaded");
    expect(calls.settle).toBe(0);
  });

  it("never settles when the handler answers 500, and passes its response through", async () => {
    const { GET, calls } = makeRoute(async () =>
      Response.json({ error: "upstream down" }, { status: 500 }),
    );

    const response = await GET(paidRequest());

    expect(response.status).toBe(500);
    expect(response.headers.get("payment-response")).toBeNull();
    expect(await response.json()).toEqual({ error: "upstream down" });
    expect(calls.settle).toBe(0);
  });

  it("discards the handler's response and answers the rejection when settlement fails", async () => {
    const { GET, calls } = makeRoute(
      async () => Response.json({ quote: 42 }, { headers: { "x-secret-data": "1" } }),
      { refuse: true },
    );

    const response = await GET(paidRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "settlement-failed",
        message: "the facilitator refused to settle the payment",
        upstreamReason: "tx failed",
      },
    });
    expect(response.headers.get("x-secret-data")).toBeNull();
    expect(response.headers.get("payment-response")).toBeNull();
    expect(calls.settle).toBe(1);
  });

  it("answers response-too-large and never settles a streamed response over the limit", async () => {
    const { GET, calls } = makeRoute(async () => new Response(streamed(10)));

    const response = await GET(paidRequest());

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("response-too-large");
    expect(calls.settle).toBe(0);
  });

  it("holds a streamed response under the limit", async () => {
    const { GET, calls } = makeRoute(
      async () => new Response(streamed(3), { status: 201, headers: { "x-route": "yes" } }),
    );

    const response = await GET(paidRequest());

    expect(response.status).toBe(201);
    expect(response.headers.get("x-route")).toBe("yes");
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(await response.text()).toBe("012345678901234567890123456789");
    expect(calls.settle).toBe(1);
  });

  it("answers 402 without running the handler when payment is missing", async () => {
    let ran = false;
    const { GET, calls } = makeRoute(async () => {
      ran = true;
      return Response.json({});
    });

    const response = await GET(new Request("https://example.test/paid"));

    expect(response.status).toBe(402);
    expect(ran).toBe(false);
    expect(calls.settle).toBe(0);
  });

  it("replays a settled payment without settling again, with its receipt", async () => {
    const seen: Array<string | undefined> = [];
    const { GET, calls } = makeRoute(async (_request, { receipt }) => {
      seen.push(receipt?.receipt.id);
      return Response.json({ quote: 42 });
    });

    await GET(paidRequest());
    const replay = await GET(paidRequest());

    expect(replay.status).toBe(200);
    expect(replay.headers.get("payment-response")).toBeTruthy();
    // The first run had no receipt yet; the replay has the settled one.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeTruthy();
    expect(calls.settle).toBe(1);
  });

  it("refuses a gate that cannot settle after the handler", () => {
    const handWritten: Gate = async () => ({
      kind: "rejected",
      status: 500,
      code: "handler-not-configured",
      reason: "x",
    });

    expect(() =>
      withPaywall(handWritten, async () => Response.json({}), { settlement: "after-handler" }),
    ).toThrow(TypeError);
  });

  it("settles after the handler through a route table", async () => {
    const { client, calls } = facilitator();
    const routes = createRouteTable({ "GET /paid/:id": config }, { signer, facilitator: client });
    const GET = withRouteTable(
      routes,
      async () => Response.json({ error: "busy" }, { status: 503 }),
      { settlement: "after-handler" },
    );

    const response = await GET(paidRequest("/paid/1"));

    expect(response.status).toBe(503);
    expect(calls.settle).toBe(0);
  });
});
