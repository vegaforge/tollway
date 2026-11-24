/**
 * Framework-free conformance cases for the four payment adapters (#107).
 *
 * The suite knows nothing about Express, Fastify, Hono or Next. Each adapter's
 * test file supplies a driver that mounts a gate and sends requests through
 * the real framework stack, then calls `runAdapterConformance`. Only the
 * framework-specific driver lives in the adapter package.
 */

import assert from "node:assert/strict";
import { Ed25519Signer, type SignedReceipt } from "@vegaforge/tollway-core";
import {
  createMockFacilitator,
  createPaywall,
  encodePaymentSignatureHeader,
  type Gate,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
  TOLLWAY_RECEIPT_HEADER,
} from "../index.js";

/** A minimal request sent by a driver, expressed without framework types. */
export type ConformanceRequest = {
  method?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
};

/** A minimal response returned by a driver, expressed without framework types. */
export type ConformanceResponse = {
  status: number;
  header(name: string): string | null | undefined;
  text(): Promise<string>;
};

/** A mounted adapter under test. */
export type ConformanceApp = {
  send(request?: ConformanceRequest): Promise<ConformanceResponse>;
  close(): Promise<void>;
};

/** What an adapter driver must supply. */
export type AdapterDriver = {
  create(options: {
    gate: Gate;
    /** Called once by the paid handler with the receipt the adapter exposed. */
    onPaid(receipt: SignedReceipt): void;
  }): Promise<ConformanceApp>;
};

/** The test-runner hooks, injected so this package needs no test dependency. */
export type ConformanceRunner = {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
};

const PATH = "/quotes/latest";

/** A repeated payment header reaches the gate as one joined value, which does not decode. */
const REPEATED_PAYMENT_STATUS = 400;

const config = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
} satisfies PaywallConfig;

/** The stable body adapters must answer when the gate itself throws. */
export const GATE_UNAVAILABLE_BODY = { error: "payment backend unavailable" } as const;

/**
 * Builds a Web `Headers` for a driver that sends a Fetch `Request`. A header
 * given as an array is appended once per value, so it reaches the adapter as
 * a repeated field, not as one value the driver picked.
 */
export function toWebHeaders(headers: ConformanceRequest["headers"] = {}): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) out.append(name, item);
  }
  return out;
}

/** Adapts a Web `Response` (Hono, Next) to the suite's shape. */
export async function webConformanceResponse(response: Response): Promise<ConformanceResponse> {
  const body = await response.text();
  return {
    status: response.status,
    header: (name) => response.headers.get(name),
    text: async () => body,
  };
}

function paymentHeader(transaction = "conformance-payment"): string {
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

async function realGate(): Promise<Gate> {
  const signer = await Ed25519Signer.generate("adapter-conformance");
  return createPaywall(config, { signer, facilitator: createMockFacilitator() });
}

async function jsonBody(response: ConformanceResponse): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/**
 * Runs the same cases against any adapter driver. Add a case here, not in four
 * adapter test files, when a new gate behaviour must hold everywhere.
 */
export function runAdapterConformance(driver: AdapterDriver, runner: ConformanceRunner): void {
  const { describe, it } = runner;

  describe("adapter conformance (#107)", () => {
    it("answers an unpaid request with 402, a challenge header and a challenge body", async () => {
      const app = await driver.create({ gate: await realGate(), onPaid: () => {} });
      try {
        const response = await app.send({ path: PATH });
        assert.equal(response.status, 402);
        assert.ok(response.header(PAYMENT_REQUIRED_HEADER), "the challenge header is missing");
        const body = await jsonBody(response);
        const accepts = body.accepts as Array<{ amount?: string }> | undefined;
        assert.equal(accepts?.[0]?.amount, config.amount);
      } finally {
        await app.close();
      }
    });

    it("runs the paid handler with the receipt and sets the response headers", async () => {
      const receipts: SignedReceipt[] = [];
      const app = await driver.create({
        gate: await realGate(),
        onPaid: (receipt) => receipts.push(receipt),
      });
      try {
        const response = await app.send({
          path: PATH,
          headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("conformance-settled") },
        });
        assert.equal(response.status, 200);
        assert.equal(receipts.length, 1, "the paid handler was not called exactly once");
        assert.equal(receipts[0]?.receipt.amount, config.amount);
        assert.ok(response.header(PAYMENT_RESPONSE_HEADER), "PAYMENT-RESPONSE is missing");
        assert.ok(response.header(TOLLWAY_RECEIPT_HEADER), "TOLLWAY-RECEIPT is missing");
        assert.equal((await jsonBody(response)).receiptId, receipts[0]?.receipt.id);
      } finally {
        await app.close();
      }
    });

    for (const status of [400, 402, 409, 429, 500, 501, 502, 503]) {
      it(`passes a ${status} rejection through as { error }`, async () => {
        const gate: Gate = async () => ({
          kind: "rejected",
          status,
          reason: `gate says ${status}`,
          ...(status === 429 ? { headers: { "retry-after": "7" } } : {}),
        });
        const app = await driver.create({ gate, onPaid: () => {} });
        try {
          const response = await app.send({ path: PATH });
          assert.equal(response.status, status);
          assert.deepEqual(await jsonBody(response), { error: `gate says ${status}` });
          if (status === 429) assert.equal(response.header("retry-after"), "7");
        } finally {
          await app.close();
        }
      });
    }

    // Node and the Fetch API both join a repeated field into one value with
    // ", ". Two payment signatures in one request are ambiguous, so every
    // adapter must refuse them the same way rather than settle either one.
    it("refuses a repeated payment header without settling either value", async () => {
      const receipts: SignedReceipt[] = [];
      const app = await driver.create({
        gate: await realGate(),
        onPaid: (receipt) => receipts.push(receipt),
      });
      try {
        const response = await app.send({
          path: PATH,
          headers: {
            [PAYMENT_SIGNATURE_HEADER]: [
              paymentHeader("conformance-repeated-a"),
              paymentHeader("conformance-repeated-b"),
            ],
          },
        });
        assert.equal(response.status, REPEATED_PAYMENT_STATUS);
        const body = await jsonBody(response);
        assert.equal(typeof body.error, "string", "the rejection has no { error }");
        assert.equal(receipts.length, 0, "the paid handler ran for an ambiguous payment");
        assert.equal(response.header(PAYMENT_RESPONSE_HEADER), null);
      } finally {
        await app.close();
      }
    });

    it("finds the payment header regardless of name case", async () => {
      const receipts: SignedReceipt[] = [];
      const app = await driver.create({
        gate: await realGate(),
        onPaid: (receipt) => receipts.push(receipt),
      });
      try {
        const response = await app.send({
          path: PATH,
          headers: { "pAyMeNt-SiGnAtUrE": paymentHeader("conformance-case") },
        });
        assert.equal(response.status, 200);
        assert.equal(receipts.length, 1);
      } finally {
        await app.close();
      }
    });

    it("answers a thrown gate error with 502 and no internal message", async () => {
      const secret = "internal facilitator token: abc123";
      const gate: Gate = async () => {
        throw new Error(secret);
      };
      const app = await driver.create({ gate, onPaid: () => {} });
      try {
        const response = await app.send({ path: PATH });
        assert.equal(response.status, 502);
        const body = await response.text();
        assert.ok(!body.includes(secret), `the internal error leaked: ${body}`);
        assert.deepEqual(JSON.parse(body), GATE_UNAVAILABLE_BODY);
      } finally {
        await app.close();
      }
    });
  });
}
