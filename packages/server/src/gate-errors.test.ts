import { Ed25519Signer, TollwayError } from "@vegaforge/tollway-core";
import RedisMock from "ioredis-mock";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
} from "./cache.js";
import {
  createHttpFacilitator,
  createMockFacilitator,
  type FacilitatorClient,
} from "./facilitator.js";
import { createPaywall, type GateOutcome, type PaywallConfig, type PaywallDeps } from "./gate.js";
import {
  GATE_ERROR_CODES,
  GATE_ERRORS,
  type GateErrorCode,
  renderGateRejection,
} from "./gate-errors.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  MPP_AUTHORIZATION_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";
import { SERVICE_POLICY_DENIALS } from "./service-policy.js";

/**
 * Issue #161: every rejection the gate can return carries a stable `code`
 * whose status matches GATE_ERRORS, and the facilitator's own words travel
 * only in `upstreamReason`.
 */

const config = {
  amount: "10000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

const request = { method: "GET", url: "/quotes/latest", headers: {} };

function paid(transaction = "mock-signed-auth-entry", x402Version = 2) {
  return {
    ...request,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version,
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
      }),
    },
  };
}

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("gate-errors");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function gateWith(facilitator: FacilitatorClient, deps: Partial<PaywallDeps> = {}) {
  return createPaywall(config, { signer, facilitator, ...deps });
}

function expectRejection(
  outcome: GateOutcome,
  code: GateErrorCode,
): Extract<GateOutcome, { kind: "rejected" }> {
  expect(outcome).toMatchObject({ kind: "rejected", code, status: GATE_ERRORS[code].status });
  if (outcome.kind !== "rejected") throw new Error("expected a rejection");
  // Header names are case-insensitive on the wire; the table lists them lowercase.
  const sent = Object.keys(outcome.headers ?? {}).map((name) => name.toLowerCase());
  for (const header of GATE_ERRORS[code].headers) {
    expect(sent, `${code} carries ${header}`).toContain(header);
  }
  return outcome;
}

describe("gate error codes", () => {
  it("codes an unreadable PAYMENT-SIGNATURE as payment-malformed", async () => {
    const gate = gateWith(createMockFacilitator());
    expectRejection(
      await gate({ ...request, headers: { [PAYMENT_SIGNATURE_HEADER]: "%%%" } }),
      "payment-malformed",
    );
    expectRejection(await gate(paid("mock-signed-auth-entry", 1)), "payment-malformed");
  });

  it("codes a refused /verify as payment-invalid with a fresh challenge and the facilitator's reason apart", async () => {
    const inner = createMockFacilitator();
    const gate = gateWith({
      ...inner,
      async verify() {
        return { valid: false, reason: "invalid_exact_stellar_payload_simulation_failed" };
      },
    });
    const outcome = expectRejection(await gate(paid()), "payment-invalid");
    expect(outcome.upstreamReason).toBe("invalid_exact_stellar_payload_simulation_failed");
    expect(outcome.reason).not.toBe(outcome.upstreamReason);
    const challenge = decodePaymentRequiredHeader(outcome.headers?.[PAYMENT_REQUIRED_HEADER] ?? "");
    expect(challenge.accepts).toEqual([
      expect.objectContaining({ amount: config.amount, payTo: config.payTo }),
    ]);
  });

  it("codes a payment settled for another route as offer-mismatch, with no Retry-After", async () => {
    const cache = createInMemorySettlementCache();
    const facilitator = createMockFacilitator();
    const first = createPaywall({ ...config, resource: "/a" }, { signer, facilitator, cache });
    const second = createPaywall({ ...config, resource: "/b" }, { signer, facilitator, cache });
    expect((await first(paid())).kind).toBe("settled");
    const outcome = expectRejection(await second(paid()), "offer-mismatch");
    expect(outcome.headers?.["retry-after"]).toBeUndefined();
  });

  it("codes a held lock as settlement-in-progress with a configurable Retry-After", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const keyPrefix = "gate-errors:in-progress:";
    const facilitator = createMockFacilitator();
    const cache = createRedisSettlementCache({ client, keyPrefix });
    const nonce = await facilitator.idempotencyKey?.({
      payment: {
        model: "x402",
        payload: {
          x402Version: 2,
          accepted: {} as never,
          payload: { transaction: "mock-signed-auth-entry" },
        },
      },
    });
    await cache.acquire(`x402:${nonce}`, 30_000);

    const byDefault = expectRejection(
      await gateWith(facilitator, { cache })(paid()),
      "settlement-in-progress",
    );
    expect(byDefault.headers?.["retry-after"]).toBe("1");

    const configured = expectRejection(
      await gateWith(facilitator, { cache, retryAfterSeconds: { settlementInProgress: 5 } })(
        paid(),
      ),
      "settlement-in-progress",
    );
    expect(configured.headers?.["retry-after"]).toBe("5");
  });

  it("codes a refused /settle as settlement-failed with the facilitator's reason apart", async () => {
    const inner = createMockFacilitator();
    const outcome = expectRejection(
      await gateWith({
        ...inner,
        async settle() {
          return { settled: false, reason: "transaction_failed" };
        },
      })(paid()),
      "settlement-failed",
    );
    expect(outcome.upstreamReason).toBe("transaction_failed");
  });

  it("codes an unreachable facilitator on /verify as facilitator-unavailable with Retry-After", async () => {
    const inner = createMockFacilitator();
    const settle = vi.fn(inner.settle.bind(inner));
    const gate = gateWith(
      {
        ...inner,
        settle,
        async verify() {
          throw new TollwayError("facilitator-unavailable", "facilitator /verify request failed");
        },
      },
      { retryAfterSeconds: { facilitatorUnavailable: 7 } },
    );
    const outcome = expectRejection(await gate(paid()), "facilitator-unavailable");
    expect(outcome.headers?.["retry-after"]).toBe("7");
    expect(settle).not.toHaveBeenCalled();
  });

  it("codes a /verify deadline as facilitator-unavailable", async () => {
    vi.useFakeTimers();
    try {
      const inner = createMockFacilitator();
      const gate = gateWith(
        { ...inner, verify: () => new Promise(() => {}) },
        { facilitatorTimeoutMs: 100, ambiguousSettlementHoldMs: 1_000 },
      );
      const pending = gate(paid());
      await vi.advanceTimersByTimeAsync(100);
      expectRejection(await pending, "facilitator-unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a network failure inside createHttpFacilitator into facilitator-unavailable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const outcome = await gateWith(createHttpFacilitator("https://facilitator.test"))(paid());
    expectRejection(outcome, "facilitator-unavailable");
  });

  it("codes a /settle that may have landed as settlement-unknown", async () => {
    const inner = createMockFacilitator();
    const outcome = expectRejection(
      await gateWith(
        {
          ...inner,
          async settle() {
            throw new TollwayError(
              "facilitator-unavailable",
              "facilitator /settle request failed",
              {
                cause: new Error("socket hang up"),
              },
            );
          },
        },
        { facilitatorTimeoutMs: 100, ambiguousSettlementHoldMs: 4_000 },
      )(paid()),
      "settlement-unknown",
    );
    expect(outcome.headers?.["retry-after"]).toBe("4");
  });

  it("codes the failover client's outcome-unknown as settlement-unknown", async () => {
    const inner = createMockFacilitator();
    expectRejection(
      await gateWith({
        ...inner,
        async settle() {
          throw new TollwayError("outcome-unknown", "settlement outcome unknown on a");
        },
      })(paid()),
      "settlement-unknown",
    );
  });

  it("codes a /settle refused before sending as facilitator-unavailable, never held", async () => {
    const socket = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const inner = createMockFacilitator();
    let calls = 0;
    const gate = gateWith({
      ...inner,
      async settle(input) {
        calls += 1;
        if (calls === 1) {
          throw new TollwayError("facilitator-unavailable", "facilitator /settle request failed", {
            cause: new TypeError("fetch failed", { cause: socket }),
          });
        }
        return inner.settle(input);
      },
    });
    expectRejection(await gate(paid()), "facilitator-unavailable");
    expect((await gate(paid())).kind).toBe("settled");
  });

  it("still throws an error the gate cannot classify", async () => {
    const inner = createMockFacilitator();
    const defect = new Error("a bug in a custom facilitator client");
    await expect(
      gateWith({
        ...inner,
        async verify() {
          throw defect;
        },
      })(paid()),
    ).rejects.toBe(defect);
  });

  it("codes a /verify nonce that disagrees with the idempotency key as facilitator-invalid-response", async () => {
    const inner = createMockFacilitator();
    expectRejection(
      await gateWith({
        ...inner,
        async verify() {
          return { valid: true, payer: "GPAYER", nonce: "not-the-derived-key" };
        },
      })(paid()),
      "facilitator-invalid-response",
    );
  });

  it("codes a failing dynamic price as price-unavailable", async () => {
    const gate = createPaywall(
      {
        ...config,
        amount: () => {
          throw new Error("pricing backend down");
        },
        minAmount: "1",
        maxAmount: "100",
        quoteSecret: "secret",
      },
      { signer, facilitator: createMockFacilitator(), onPriceError: () => {} },
    );
    expectRejection(await gate(request), "price-unavailable");
  });

  it("codes an MPP credential with no handler as handler-not-configured", async () => {
    const gate = createPaywall(
      { ...config, models: ["mpp-charge"] },
      { signer, facilitator: createMockFacilitator() },
    );
    expectRejection(
      await gate({ ...request, headers: { [MPP_AUTHORIZATION_HEADER]: "Payment abc" } }),
      "handler-not-configured",
    );
  });

  it("codes a router choice the gate cannot settle as model-not-supported", async () => {
    const gate = gateWith(createMockFacilitator(), {
      router: { decide: async () => ({ model: "mpp-channel", reason: "override" }) },
    });
    expectRejection(await gate(paid()), "model-not-supported");
  });

  it("codes service policy denials with their policy codes", async () => {
    const gate = gateWith(createMockFacilitator(), { servicePolicy: { allowPayers: ["GNOBODY"] } });
    const outcome = await gate(paid());
    expect(outcome).toMatchObject({ kind: "rejected", code: SERVICE_POLICY_DENIALS.notAllowed });
  });
});

describe("renderGateRejection", () => {
  it("renders every code with its table status and the same body shape", () => {
    for (const code of GATE_ERROR_CODES) {
      const headers = Object.fromEntries(GATE_ERRORS[code].headers.map((name) => [name, "x"]));
      const rendered = renderGateRejection({
        kind: "rejected",
        status: GATE_ERRORS[code].status,
        code,
        reason: `message for ${code}`,
        headers,
      });
      expect(rendered).toEqual({
        status: GATE_ERRORS[code].status,
        headers,
        body: { error: { code, message: `message for ${code}` } },
      });
    }
  });

  it("puts an upstream reason in its own field, never in the code", () => {
    expect(
      renderGateRejection({
        kind: "rejected",
        status: 402,
        code: "payment-invalid",
        reason: "the facilitator refused the payment",
        upstreamReason: "invalid_exact_stellar_payload_wrong_amount",
      }).body,
    ).toEqual({
      error: {
        code: "payment-invalid",
        message: "the facilitator refused the payment",
        upstreamReason: "invalid_exact_stellar_payload_wrong_amount",
      },
    });
  });
});
