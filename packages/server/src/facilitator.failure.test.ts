import type { PaymentOffer, X402Payment } from "@vegaforge/tollway-core";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpFacilitator } from "./facilitator.js";

/**
 * Faults at the HTTP boundary. These cover what happens when the facilitator
 * process is unhealthy rather than merely wrong: a hung socket, a body that
 * is not the protocol, and a connection that fails outright. The gate turns
 * none of these into a settlement. See docs/failure-modes.md.
 */

const offer: PaymentOffer = {
  resource: "https://api.example.com/quotes/latest",
  amount: "10000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  models: ["x402"],
};

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: offer.asset,
  amount: offer.amount,
  payTo: offer.payTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

const payment: X402Payment = {
  model: "x402",
  payload: {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: "AAAA-base64-stellar-tx" },
  },
};

const FACILITATOR_URL = "https://facilitator.test";

describe("facilitator transport faults", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    // @x402/core arms its transport deadline with AbortSignal.timeout, which
    // fake timers do not drive. Route it through setTimeout so the test
    // controls the clock and nothing waits on wall time.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Runs `call` and moves the fake clock past the transport deadline. */
  async function pastDeadline<T>(call: Promise<T>, timeoutMs: number): Promise<T> {
    const settled = call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(timeoutMs);
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** A socket that stays open until the client's abort signal fires. */
  function hangingSocket(_url: string, init: RequestInit): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }

  it("gives up on a hung /verify at the transport deadline", async () => {
    fetchMock.mockImplementation(hangingSocket);

    await expect(
      pastDeadline(
        createHttpFacilitator(FACILITATOR_URL, { timeoutMs: 5_000 }).verify({ payment, offer }),
        5_000,
      ),
    ).rejects.toMatchObject({ code: "payment-failed" });
  });

  it("gives up on a hung /settle at the transport deadline", async () => {
    fetchMock.mockImplementation(hangingSocket);

    await expect(
      pastDeadline(
        createHttpFacilitator(FACILITATOR_URL, { timeoutMs: 5_000 }).settle({
          payment,
          offer,
          payer: "GPAYER",
          nonce: "n",
        }),
        5_000,
      ),
    ).rejects.toMatchObject({ code: "payment-failed" });
  });

  it("rejects a /verify response that is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway error</html>", { status: 200 }));

    await expect(
      createHttpFacilitator(FACILITATOR_URL).verify({ payment, offer }),
    ).rejects.toMatchObject({ code: "payment-failed" });
  });

  it("rejects a /verify body that does not match the protocol", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ isValid: "yes", payer: "GPAYER" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      createHttpFacilitator(FACILITATOR_URL).verify({ payment, offer }),
    ).rejects.toMatchObject({ code: "payment-failed" });
  });

  it("wraps a connection failure on /settle", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createHttpFacilitator(FACILITATOR_URL).settle({
        payment,
        offer,
        payer: "GPAYER",
        nonce: "n",
      }),
    ).rejects.toMatchObject({ code: "payment-failed" });
  });

  it("wraps a failed /supported", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream boom", { status: 500 }));

    await expect(createHttpFacilitator(FACILITATOR_URL).supported()).rejects.toMatchObject({
      code: "payment-failed",
    });
  });
});
