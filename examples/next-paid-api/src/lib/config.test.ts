import { describe, expect, it } from "vitest";
import {
  DEFAULT_TESTNET_ASSET,
  DEFAULT_TESTNET_PAY_TO,
  ExampleConfigError,
  resolveConfig,
  TESTNET_FACILITATOR_URL,
} from "./config";

function problemsOf(env: Record<string, string>): string[] {
  try {
    resolveConfig(env);
  } catch (error) {
    if (error instanceof ExampleConfigError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error("expected resolveConfig to fail");
}

describe("resolveConfig", () => {
  it("starts local mock mode with no secrets and the in-memory cache", () => {
    expect(resolveConfig({})).toMatchObject({
      mode: "mock",
      deployed: false,
      receiptKey: undefined,
      redisUrl: undefined,
      facilitator: { kind: "mock" },
      payTo: DEFAULT_TESTNET_PAY_TO,
      asset: DEFAULT_TESTNET_ASSET,
    });
  });

  it("defaults to valid testnet values: a G account and the USDC contract", () => {
    expect(DEFAULT_TESTNET_PAY_TO).toMatch(/^G[A-Z2-7]{55}$/);
    expect(DEFAULT_TESTNET_ASSET).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("uses the OpenZeppelin Channels testnet facilitator in testnet mode", () => {
    const config = resolveConfig({
      TOLLWAY_MODE: "testnet",
      TOLLWAY_RECEIPT_KEY: "a-key",
      OZ_API_KEY: "oz-key",
    });
    expect(config.facilitator).toEqual({
      kind: "http",
      url: TESTNET_FACILITATOR_URL,
      apiKey: "oz-key",
    });
  });

  it("refuses testnet mode without a receipt key or an API key", () => {
    const problems = problemsOf({ TOLLWAY_MODE: "testnet" });
    expect(problems.some((problem) => problem.startsWith("TOLLWAY_RECEIPT_KEY is not set"))).toBe(
      true,
    );
    expect(problems.some((problem) => problem.startsWith("OZ_API_KEY is not set"))).toBe(true);
  });

  it("refuses a deployment without a receipt key, even in mock mode", () => {
    const problems = problemsOf({ TOLLWAY_DEPLOYED: "true", REDIS_URL: "redis://cache:6379" });
    expect(problems).toEqual([
      "TOLLWAY_RECEIPT_KEY is not set. Generate one as described in the README, section 'Receipt key'",
    ]);
  });

  it("refuses a deployment without Redis configuration", () => {
    const problems = problemsOf({ TOLLWAY_DEPLOYED: "true", TOLLWAY_RECEIPT_KEY: "a-key" });
    expect(problems).toEqual([
      "REDIS_URL is not set. A deployment needs Redis so a payment settles once across instances",
    ]);
  });

  it("rejects unknown modes, flags and malformed addresses", () => {
    expect(
      problemsOf({
        TOLLWAY_MODE: "mainnet",
        TOLLWAY_DEPLOYED: "yes",
        TOLLWAY_PAY_TO: "GXXXX",
        TOLLWAY_ASSET: "USDC:GA5Z",
      }),
    ).toHaveLength(4);
  });
});
