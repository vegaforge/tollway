import { Ed25519Signer } from "@vegaforge/tollway-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import {
  createHttpFacilitator,
  createMockFacilitator,
  type FacilitatorClient,
} from "./facilitator.js";
import { createPaywall, type PaywallConfig, type PaywallDeps } from "./gate.js";
import {
  encodePaymentSignatureHeader,
  MPP_AUTHORIZATION_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";
import { createMockMppChargeHandler } from "./mpp-charge.js";
import {
  createInMemoryPaymentReceiptArchive,
  type PaymentReceiptArchive,
} from "./payment-receipt-archive.js";
import {
  AMOUNT,
  ASSET,
  envelope,
  PAY_TO,
  PAYER,
  REQUIREMENTS,
} from "./testing/stellar-envelopes.js";

/**
 * Issue #162: a payment that settled, retried after its entry left the
 * short-lived settlement cache, gets its original receipt from the archive,
 * before /verify, so the facilitator never sees it again.
 */

const config = {
  amount: AMOUNT,
  asset: ASSET,
  payTo: PAY_TO,
  network: "testnet",
} satisfies PaywallConfig;
const CACHE_TTL_MS = 30_000;
const request = { method: "GET", url: "/quotes/latest", headers: {} };

function paid(transaction: string, url = request.url) {
  return {
    ...request,
    url,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: { ...REQUIREMENTS },
        payload: { transaction },
      }),
    },
  };
}

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("receipt-archive");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A cache on a clock the test moves, and an archive with no expiry. */
function stores() {
  const clock = { now: 0 };
  const cache = createInMemorySettlementCache(CACHE_TTL_MS, { now: () => clock.now });
  const archive = createInMemoryPaymentReceiptArchive({ now: () => clock.now });
  return { clock, cache, archive };
}

function spiedMock() {
  const inner = createMockFacilitator();
  const verify = vi.fn(inner.verify.bind(inner));
  const settle = vi.fn(inner.settle.bind(inner));
  const facilitator: FacilitatorClient = { ...inner, verify, settle };
  return { facilitator, verify, settle };
}

describe("replays from the receipt archive", () => {
  it("serves the original receipt after cache expiry with no facilitator call (mock facilitator)", async () => {
    const { clock, cache, archive } = stores();
    const { facilitator, verify, settle } = spiedMock();
    const gate = createPaywall(config, { signer, facilitator, cache, receiptArchive: archive });

    const first = await gate(paid("mock-envelope-1"));
    if (first.kind !== "settled") throw new Error("expected a settlement");
    clock.now = CACHE_TTL_MS + 1;
    expect(
      await cache.get(
        `x402:${await facilitator.idempotencyKey?.({ payment: { model: "x402", payload: { x402Version: 2, accepted: { ...REQUIREMENTS }, payload: { transaction: "mock-envelope-1" } } } })}`,
      ),
    ).toBeUndefined();

    const retry = await gate(paid("mock-envelope-1"));
    expect(retry).toMatchObject({ kind: "settled", replayed: true });
    if (retry.kind !== "settled") return;
    expect(retry.receipt).toEqual(first.receipt);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("never reaches an HTTP facilitator that would reject the reused payment", async () => {
    const calls: string[] = [];
    let settled = false;
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/verify") {
        // On chain the authorization nonce is spent once settled.
        return Response.json(
          settled
            ? { isValid: false, invalidReason: "invalid_exact_stellar_payload_simulation_failed" }
            : { isValid: true, payer: PAYER.publicKey() },
        );
      }
      settled = true;
      return Response.json({
        success: true,
        transaction: "cd".repeat(32),
        network: "stellar:testnet",
        payer: PAYER.publicKey(),
      });
    });
    const { clock, cache, archive } = stores();
    const gate = createPaywall(config, {
      signer,
      facilitator: createHttpFacilitator("https://facilitator.test"),
      cache,
      receiptArchive: archive,
    });
    const payment = paid(envelope());

    const first = await gate(payment);
    expect(first.kind).toBe("settled");
    expect(calls).toEqual(["/verify", "/settle"]);
    clock.now = CACHE_TTL_MS + 1;

    const retry = await gate(payment);
    expect(retry).toMatchObject({ kind: "settled", replayed: true });
    if (first.kind === "settled" && retry.kind === "settled") {
      expect(retry.receipt).toEqual(first.receipt);
    }
    expect(calls).toEqual(["/verify", "/settle"]);
  });

  it("answers 409 for an archived payment replayed against another offer, never a replay", async () => {
    const { clock, cache, archive } = stores();
    const { facilitator, settle } = spiedMock();
    const deps = { signer, facilitator, cache, receiptArchive: archive };
    const latest = createPaywall({ ...config, resource: "/latest" }, deps);
    const history = createPaywall({ ...config, resource: "/history" }, deps);

    expect((await latest(paid("mock-envelope-2"))).kind).toBe("settled");
    clock.now = CACHE_TTL_MS + 1;
    expect(await history(paid("mock-envelope-2"))).toMatchObject({
      status: 409,
      code: "offer-mismatch",
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("replays an MPP charge after cache expiry through the handler's local payment key", async () => {
    const { clock, cache, archive } = stores();
    const inner = createMockMppChargeHandler();
    const settle = vi.fn(inner.settle.bind(inner));
    const gate = createPaywall(
      { ...config, models: ["mpp-charge"] },
      {
        signer,
        facilitator: createMockFacilitator(),
        mppChargeHandler: { ...inner, settle },
        cache,
        receiptArchive: archive,
      },
    );
    const credential = { ...request, headers: { [MPP_AUTHORIZATION_HEADER]: "Payment mpp-1" } };
    const first = await gate(credential);
    expect(first.kind).toBe("settled");
    clock.now = CACHE_TTL_MS + 1;
    expect(await gate(credential)).toMatchObject({ kind: "settled", replayed: true });
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe("receipt archive failures", () => {
  function failingArchive(on: "read" | "write"): PaymentReceiptArchive & { failure: Error } {
    const failure = new Error(`archive ${on} failed`);
    const memory = createInMemoryPaymentReceiptArchive();
    return {
      failure,
      async findByPaymentKey(key) {
        if (on === "read") throw failure;
        return memory.findByPaymentKey(key);
      },
      async put(key, entry) {
        if (on === "write") throw failure;
        return memory.put(key, entry);
      },
    };
  }

  it("reports a failed read and falls back to /verify, which stays authoritative", async () => {
    const { facilitator, verify } = spiedMock();
    const archive = failingArchive("read");
    const onArchiveError = vi.fn();
    const gate = createPaywall(config, {
      signer,
      facilitator,
      receiptArchive: archive,
      onArchiveError,
    });
    const outcome = await gate(paid("mock-envelope-3"));
    expect(outcome.kind).toBe("settled");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(onArchiveError).toHaveBeenCalledWith(archive.failure, expect.stringMatching(/^x402:/));
  });

  it("still returns the receipt when the archive write fails after settlement, and reports it", async () => {
    const archive = failingArchive("write");
    const onCacheError = vi.fn();
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
      receiptArchive: archive,
      onCacheError,
    });
    const outcome = await gate(paid("mock-envelope-4"));
    expect(outcome).toMatchObject({
      kind: "settled",
      replayed: false,
      cacheError: archive.failure,
    });
    expect(onCacheError).toHaveBeenCalledWith(archive.failure, expect.stringMatching(/^x402:/));
  });

  it("writes a payment that settled after the /settle deadline to the archive", async () => {
    vi.useFakeTimers();
    try {
      const inner = createMockFacilitator();
      let release: () => void = () => {};
      const late = new Promise<void>((resolve) => {
        release = resolve;
      });
      const facilitator: FacilitatorClient = {
        ...inner,
        async settle(input) {
          await late;
          return inner.settle(input);
        },
      };
      const archive = createInMemoryPaymentReceiptArchive();
      const deps: Partial<PaywallDeps> = {
        cache: createInMemorySettlementCache(),
        receiptArchive: archive,
        facilitatorTimeoutMs: 100,
        ambiguousSettlementHoldMs: 10_000,
      };
      const gate = createPaywall(config, { signer, facilitator, ...deps });
      const pending = gate(paid("mock-envelope-5"));
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ code: "settlement-unknown" });
      release();
      vi.useRealTimers();
      await vi.waitFor(async () => {
        const key = await inner.idempotencyKey?.({
          payment: {
            model: "x402",
            payload: {
              x402Version: 2,
              accepted: { ...REQUIREMENTS },
              payload: { transaction: "mock-envelope-5" },
            },
          },
        });
        expect(await archive.findByPaymentKey(`x402:${key}`)).toBeDefined();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
