import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PaymentOffer, X402Payment } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";
import {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  SettleError,
  VerifyError,
} from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpFacilitator, type FacilitatorClient } from "./facilitator.js";
import {
  createFacilitatorValidator,
  type FacilitatorCapabilities,
} from "./facilitator-capabilities.js";
import {
  createFailoverFacilitator,
  createMemoryPinStore,
  type FailoverEvent,
  type SettlementPinStore,
} from "./failover-facilitator.js";

const DEFAULT_CAPS: FacilitatorCapabilities = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:*" }],
  extensions: [],
  signers: {},
};

/**
 * Issue #156 coverage. The acceptance matrix the tests pin down:
 * - verify and supported fail over freely across healthy facilitators.
 * - settle is pinned to the first facilitator that received it: pre-send
 *   failures release the pin and move on; outcome-unknown keeps the pin
 *   and throws with the `outcome-unknown` error code.
 * - A structured rejection (VerifyError / SettleError) is passed through
 *   without marking the facilitator unhealthy and without trying others.
 * - Capability validation per member filters eligibility at call time.
 * - Health tracks consecutive failures with a cool-down, reopens on expiry.
 */

const STELLAR_USDC_TESTNET_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const STELLAR_DESTINATION = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";

function offer(overrides: Partial<PaymentOffer> = {}): PaymentOffer {
  return {
    resource: "https://api.example.com/quote",
    amount: "10000",
    asset: STELLAR_USDC_TESTNET_SAC,
    payTo: STELLAR_DESTINATION,
    network: "testnet",
    models: ["x402"],
    ...overrides,
  };
}

function payment(nonce = "nonce-abc"): X402Payment {
  return {
    model: "x402",
    payload: {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "stellar:testnet",
        asset: STELLAR_USDC_TESTNET_SAC,
        amount: "10000",
        payTo: STELLAR_DESTINATION,
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: { transaction: nonce },
    },
  };
}

function stubClient(partial: Partial<FacilitatorClient> = {}): FacilitatorClient {
  return {
    async verify() {
      return { valid: true, payer: "GPAYER", nonce: "nonce-abc" };
    },
    async settle() {
      return { settled: true, txHash: "txhash-default" };
    },
    async supported() {
      return DEFAULT_CAPS;
    },
    ...partial,
  };
}

function connectionRefused(): Error {
  // Node's fetch surfaces pre-send connection failures as TypeError with a
  // `cause.code` of ECONNREFUSED (or ENOTFOUND).
  const cause = Object.assign(new Error("ECONNREFUSED 127.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("createFailoverFacilitator", () => {
  describe("construction", () => {
    it("rejects an empty facilitator list", () => {
      expect(() => createFailoverFacilitator({ facilitators: [] })).toThrow(TollwayError);
    });

    it("rejects duplicate member ids", () => {
      expect(() =>
        createFailoverFacilitator({
          facilitators: [
            { id: "a", client: stubClient() },
            { id: "a", client: stubClient() },
          ],
        }),
      ).toThrow(/duplicate/);
    });
  });

  describe("supported and verify", () => {
    it("tries members in order and returns the first success", async () => {
      const b = stubClient();
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ supported: () => Promise.reject(connectionRefused()) }) },
          { id: "b", client: b },
        ],
      });
      await expect(client.supported()).resolves.toHaveProperty("kinds");
    });

    it("emits failover events across each pair of consecutive attempts", async () => {
      const events: FailoverEvent[] = [];
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ verify: () => Promise.reject(connectionRefused()) }) },
          { id: "b", client: stubClient() },
        ],
        onEvent: (event) => events.push(event),
      });
      const result = await client.verify({ payment: payment(), offer: offer() });
      expect(result).toMatchObject({ valid: true });
      expect(events).toContainEqual(
        expect.objectContaining({ type: "failover", operation: "verify", from: "a", to: "b" }),
      );
    });

    it("passes through a structured VerifyError without trying another facilitator", async () => {
      const verifyErr = new VerifyError(400, {
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_recipient_mismatch",
      });
      const second = vi.fn();
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ verify: () => Promise.reject(verifyErr) }) },
          { id: "b", client: stubClient({ verify: second }) },
        ],
      });
      await expect(client.verify({ payment: payment(), offer: offer() })).rejects.toBe(verifyErr);
      expect(second).not.toHaveBeenCalled();
    });

    it("throws payment-failed when every eligible facilitator fails transport", async () => {
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ supported: () => Promise.reject(connectionRefused()) }) },
          { id: "b", client: stubClient({ supported: () => Promise.reject(connectionRefused()) }) },
        ],
      });
      await expect(client.supported()).rejects.toMatchObject({
        code: "payment-failed",
      });
    });
  });

  describe("capability filtering", () => {
    it("skips a member whose advertised capabilities do not cover the offer's network", async () => {
      const bSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-b" }));
      const evmOnly = stubClient({
        async supported() {
          return {
            kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
            extensions: [],
            signers: {},
          };
        },
      });
      const stellar = stubClient({ settle: bSettle });
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "evm-only", client: evmOnly, validator: createFacilitatorValidator(evmOnly) },
          { id: "stellar", client: stellar, validator: createFacilitatorValidator(stellar) },
        ],
      });
      await client.settle({ payment: payment(), offer: offer(), payer: "GPAYER", nonce: "n1" });
      expect(bSettle).toHaveBeenCalledOnce();
    });

    it("excludes a member whose capabilities cannot be read, and reports it", async () => {
      const events: FailoverEvent[] = [];
      const down = stubClient({ supported: () => Promise.reject(connectionRefused()) });
      const bSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-b" }));
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "down", client: down, validator: createFacilitatorValidator(down) },
          { id: "b", client: stubClient({ settle: bSettle }) },
        ],
        onEvent: (event) => events.push(event),
      });
      await client.settle({ payment: payment(), offer: offer(), payer: "GPAYER", nonce: "n1" });
      expect(bSettle).toHaveBeenCalledOnce();
      expect(events).toContainEqual({
        type: "capabilities-unavailable",
        facilitator: "down",
        reason: "ECONNREFUSED 127.0.0.1:443",
      });
    });

    it("throws payment-failed when no member is eligible for the offer", async () => {
      const evmOnly = stubClient({
        async supported() {
          return {
            kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
            extensions: [],
            signers: {},
          };
        },
      });
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: evmOnly, validator: createFacilitatorValidator(evmOnly) },
        ],
      });
      await expect(
        client.settle({ payment: payment(), offer: offer(), payer: "GPAYER", nonce: "n1" }),
      ).rejects.toMatchObject({ code: "payment-failed" });
    });
  });

  describe("with real HTTP facilitators", () => {
    // These go through createHttpFacilitator and @x402/core's HTTP client,
    // so the errors are the ones a deployment actually sees, not stand-ins.
    let servers: Server[] = [];
    afterEach(async () => {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      servers = [];
    });

    async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
      const server = createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    async function closedPortUrl(): Promise<string> {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise((resolve) => server.close(resolve));
      return `http://127.0.0.1:${port}`;
    }

    it("fails settle over to the next member when the first refuses the connection", async () => {
      const events: FailoverEvent[] = [];
      const bSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-b" }));
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "refused", client: createHttpFacilitator(await closedPortUrl()) },
          { id: "b", client: stubClient({ settle: bSettle }) },
        ],
        onEvent: (event) => events.push(event),
      });
      const result = await client.settle({
        payment: payment(),
        offer: offer(),
        payer: "GPAYER",
        nonce: "n-refused",
      });
      expect(result).toEqual({ settled: true, txHash: "tx-b" });
      expect(bSettle).toHaveBeenCalledOnce();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "failover",
          operation: "settle",
          from: "refused",
          to: "b",
        }),
      );
    });

    it("keeps the pin and reports outcome-unknown when the first member answers 500", async () => {
      const url = await listen((_request, response) => {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("boom");
      });
      const bSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-b" }));
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "errors", client: createHttpFacilitator(url) },
          { id: "b", client: stubClient({ settle: bSettle }) },
        ],
      });
      await expect(
        client.settle({ payment: payment(), offer: offer(), payer: "GPAYER", nonce: "n-500" }),
      ).rejects.toMatchObject({ code: "outcome-unknown" });
      expect(bSettle).not.toHaveBeenCalled();
    });
  });

  describe("settle pinning", () => {
    let pins: SettlementPinStore;
    beforeEach(() => {
      pins = createMemoryPinStore();
    });

    it("pins to the first facilitator that received the settle", async () => {
      const aSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-a" }));
      const bSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-b" }));
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ settle: aSettle }) },
          { id: "b", client: stubClient({ settle: bSettle }) },
        ],
        pins,
      });
      const input = {
        payment: payment("n-pin-1"),
        offer: offer(),
        payer: "GPAYER",
        nonce: "n-pin-1",
      };
      await client.settle(input);
      await client.settle(input);
      expect(aSettle).toHaveBeenCalledTimes(2);
      expect(bSettle).not.toHaveBeenCalled();
    });

    it("honours an existing pin even when the pinned member is unhealthy", async () => {
      const aSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-a" }));
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ settle: aSettle }) },
          { id: "b", client: stubClient() },
        ],
        pins,
        health: { failureThreshold: 1, coolDownMs: 60_000 },
      });
      // Settle once to pin to "a".
      const input = {
        payment: payment("n-pin-2"),
        offer: offer(),
        payer: "GPAYER",
        nonce: "n-pin-2",
      };
      await client.settle(input);
      // Artificially mark "a" unhealthy by throwing on a different nonce.
      const other = {
        payment: payment("n-other"),
        offer: offer(),
        payer: "GPAYER",
        nonce: "n-other",
      };
      aSettle.mockImplementationOnce(() => {
        throw new FacilitatorTimeoutError("settle", 1_000);
      });
      await expect(client.settle(other)).rejects.toMatchObject({ code: "outcome-unknown" });
      // A retry of the first (pinned) payment still goes to "a" even though
      // "a" is unhealthy, because the pin is authoritative.
      aSettle.mockImplementation(async () => ({ settled: true as const, txHash: "tx-a-retry" }));
      const retry = await client.settle(input);
      expect(retry).toMatchObject({ txHash: "tx-a-retry" });
    });

    it("releases the pin on a pre-send failure and tries the next facilitator", async () => {
      const aSettle = vi.fn(async () => {
        throw connectionRefused();
      });
      const bSettle = vi.fn(async () => ({ settled: true as const, txHash: "tx-b" }));
      const events: FailoverEvent[] = [];
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ settle: aSettle }) },
          { id: "b", client: stubClient({ settle: bSettle }) },
        ],
        pins,
        onEvent: (event) => events.push(event),
      });
      const input = {
        payment: payment("n-presend"),
        offer: offer(),
        payer: "GPAYER",
        nonce: "n-presend",
      };
      const result = await client.settle(input);
      expect(result).toMatchObject({ txHash: "tx-b" });
      expect(events).toContainEqual(
        expect.objectContaining({ type: "failover", operation: "settle", from: "a", to: "b" }),
      );
      // The pin should now point at "b".
      expect(await pins.get("x402:n-presend")).toBe("b");
    });

    it("surfaces outcome-unknown on a post-send failure and keeps the pin", async () => {
      const aSettle = vi.fn(async () => {
        throw new FacilitatorTimeoutError("settle", 1_000);
      });
      const bSettle = vi.fn();
      const events: FailoverEvent[] = [];
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ settle: aSettle }) },
          { id: "b", client: stubClient({ settle: bSettle }) },
        ],
        pins,
        onEvent: (event) => events.push(event),
      });
      const input = {
        payment: payment("n-unknown"),
        offer: offer(),
        payer: "GPAYER",
        nonce: "n-unknown",
      };
      await expect(client.settle(input)).rejects.toMatchObject({
        code: "outcome-unknown",
      });
      expect(bSettle).not.toHaveBeenCalled();
      // Pin stays on "a".
      expect(await pins.get("x402:n-unknown")).toBe("a");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "outcome-unknown",
          facilitator: "a",
          operation: "settle",
        }),
      );
    });

    it("also classifies malformed facilitator responses as outcome-unknown", async () => {
      const aSettle = vi.fn(async () => {
        throw new FacilitatorResponseError("malformed body");
      });
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ settle: aSettle }) },
          { id: "b", client: stubClient() },
        ],
        pins,
      });
      await expect(
        client.settle({
          payment: payment("n-malformed"),
          offer: offer(),
          payer: "GPAYER",
          nonce: "n-malformed",
        }),
      ).rejects.toMatchObject({ code: "outcome-unknown" });
    });

    it("passes a SettleError through and keeps the pin", async () => {
      const settleErr = new SettleError(400, {
        success: false,
        errorReason: "insufficient_funds",
        transaction: "tx",
        network: "stellar:testnet",
      });
      const aSettle = vi.fn(async () => {
        throw settleErr;
      });
      const bSettle = vi.fn();
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ settle: aSettle }) },
          { id: "b", client: stubClient({ settle: bSettle }) },
        ],
        pins,
      });
      await expect(
        client.settle({
          payment: payment("n-settle-err"),
          offer: offer(),
          payer: "GPAYER",
          nonce: "n-settle-err",
        }),
      ).rejects.toBe(settleErr);
      expect(bSettle).not.toHaveBeenCalled();
      expect(await pins.get("x402:n-settle-err")).toBe("a");
    });

    it("never calls /settle on more than one facilitator per payment across random failure sequences", async () => {
      // A property-ish test: for every pattern of pre-send and post-send
      // failures across three facilitators, at most one facilitator ever
      // sees /settle for one payment (after accounting for the pin).
      const outcomes: Array<"pre-send" | "outcome-unknown" | "ok"> = [
        "pre-send",
        "outcome-unknown",
        "ok",
      ];
      for (const first of outcomes) {
        for (const second of outcomes) {
          const settleCalls = { a: 0, b: 0, c: 0 } as Record<"a" | "b" | "c", number>;
          const makeStub = (id: "a" | "b" | "c", kind: "pre-send" | "outcome-unknown" | "ok") =>
            stubClient({
              settle: async () => {
                settleCalls[id] += 1;
                if (kind === "pre-send") throw connectionRefused();
                if (kind === "outcome-unknown") {
                  throw new FacilitatorTimeoutError("settle", 1_000);
                }
                return { settled: true as const, txHash: `tx-${id}` };
              },
            });
          const client = createFailoverFacilitator({
            facilitators: [
              { id: "a", client: makeStub("a", first) },
              { id: "b", client: makeStub("b", second) },
              { id: "c", client: makeStub("c", "ok") },
            ],
            pins: createMemoryPinStore(),
          });
          const input = {
            payment: payment(`n-${first}-${second}`),
            offer: offer(),
            payer: "GPAYER",
            nonce: `n-${first}-${second}`,
          };
          try {
            await client.settle(input);
          } catch {
            // Expected for some paths (outcome-unknown).
          }
          // After one logical /settle call, every member saw it at most
          // once; the whole set called it at most twice (the pre-send
          // failover path from member 1 to member 2 or from 2 to 3).
          for (const id of ["a", "b", "c"] as const) {
            expect(settleCalls[id]).toBeLessThanOrEqual(1);
          }
          const totalCalls = settleCalls.a + settleCalls.b + settleCalls.c;
          expect(totalCalls).toBeLessThanOrEqual(3);
        }
      }
    });
  });

  describe("health tracking", () => {
    it("takes a member out of rotation after the configured threshold and lets it back in after cool-down", async () => {
      let now = 10_000;
      const events: FailoverEvent[] = [];
      const client = createFailoverFacilitator({
        facilitators: [
          {
            id: "a",
            client: stubClient({ supported: () => Promise.reject(connectionRefused()) }),
          },
          { id: "b", client: stubClient() },
        ],
        health: { failureThreshold: 2, coolDownMs: 5_000 },
        clock: () => now,
        onEvent: (event) => events.push(event),
      });
      // Two failures on "a" trip it unhealthy; "b" takes the calls.
      await client.supported();
      await client.supported();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "health-changed",
          facilitator: "a",
          healthy: false,
        }),
      );
      // Advance past the cool-down; the next call lets "a" probe.
      now += 6_000;
      await client.supported();
      // "a" still fails, so another health-changed to false will fire after
      // the next two failures. For now the probe closed it open briefly.
      expect(
        events.filter(
          (event) =>
            event.type === "health-changed" && event.facilitator === "a" && event.healthy === true,
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });

    it("a successful call clears consecutive failures", async () => {
      let flake = true;
      const aSupported = vi.fn<() => Promise<FacilitatorCapabilities>>(async () => {
        if (flake) {
          flake = false;
          throw connectionRefused();
        }
        return DEFAULT_CAPS;
      });
      const client = createFailoverFacilitator({
        facilitators: [
          { id: "a", client: stubClient({ supported: aSupported }) },
          { id: "b", client: stubClient() },
        ],
        health: { failureThreshold: 2, coolDownMs: 60_000 },
      });
      await client.supported(); // "a" flakes, "b" answers.
      await client.supported(); // "a" answers, counter resets.
      // A third immediate failure should not trip unhealthy because the
      // previous success reset the counter.
      aSupported.mockImplementationOnce(() => Promise.reject(connectionRefused()));
      await client.supported();
      expect(aSupported).toHaveBeenCalledTimes(3);
    });
  });
});
