import { Keypair } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDemo } from "./demo.js";

describe("runDemo", () => {
  beforeEach(() => {
    process.env.MOCK_MODE = "true";
  });
  afterEach(() => {
    process.env.MOCK_MODE = undefined;
  });

  it("runs the x402 happy path end to end and verifies the receipt", async () => {
    const result = await runDemo();

    expect(result.mock).toBe(true);
    expect(result.challenge.amount).toBe("10000");
    expect(result.receipt.receipt.model).toBe("x402");
    expect(result.receipt.receipt.settlement.kind).toBe("transaction");
    expect(result.receiptValid).toBe(true);
  });
});

/**
 * Live mode against a stubbed facilitator. Requests to the local demo server
 * go through the real fetch; anything else is answered by the stub and
 * recorded, so the tests can check where the demo calls and what it sends.
 */
describe("runDemo in live mode", () => {
  const recipient = Keypair.random().publicKey();
  const payerKeypair = Keypair.random();
  const realFetch = globalThis.fetch;
  let facilitatorCalls: Array<{ url: string; headers: Headers }>;

  // Signs nothing: returns a fixed transaction so no Stellar RPC is needed.
  const payer = async () => "AAAAAgAAAAB0ZXN0LXRyYW5zYWN0aW9u";

  beforeEach(() => {
    facilitatorCalls = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("http://127.0.0.1:")) {
        return realFetch(input, init);
      }
      facilitatorCalls.push({ url, headers: new Headers(init?.headers) });
      const body = url.endsWith("/verify")
        ? { isValid: true, payer: payerKeypair.publicKey() }
        : {
            success: true,
            transaction: "a".repeat(64),
            network: "stellar:testnet",
            payer: payerKeypair.publicKey(),
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    for (const name of [
      "MOCK_MODE",
      "STELLAR_NETWORK",
      "FACILITATOR_URL",
      "STELLAR_RPC_URL",
      "OZ_API_KEY",
      "STELLAR_RECIPIENT",
      "STELLAR_SECRET_KEY",
    ]) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubLiveEnv() {
    vi.stubEnv("OZ_API_KEY", "k");
    vi.stubEnv("STELLAR_RECIPIENT", recipient);
    vi.stubEnv("STELLAR_SECRET_KEY", payerKeypair.secret());
  }

  it("calls the testnet facilitator in live mode", async () => {
    stubLiveEnv();
    await runDemo({ payer });

    expect(facilitatorCalls[0]?.url).toMatch(
      /^https:\/\/channels\.openzeppelin\.com\/x402\/testnet\//,
    );
  });

  it("sends the API key on verify", async () => {
    stubLiveEnv();
    await runDemo({ payer });

    const verify = facilitatorCalls.find((call) => call.url.endsWith("/verify"));
    expect(verify?.headers.get("Authorization")).toBe("Bearer k");
  });

  it("uses the USDC SAC address as the asset", async () => {
    stubLiveEnv();
    const result = await runDemo({ payer });

    expect(result.challenge.asset).toBe(USDC_TESTNET_ADDRESS);
  });

  it("reports every missing variable in live mode without calling the network", async () => {
    const run = runDemo({ payer });

    await expect(run).rejects.toMatchObject({
      name: "DemoConfigError",
      problems: [
        expect.stringContaining("OZ_API_KEY"),
        expect.stringContaining("STELLAR_RECIPIENT"),
        expect.stringContaining("STELLAR_SECRET_KEY"),
      ],
    });
    expect(facilitatorCalls).toEqual([]);
  });
});
