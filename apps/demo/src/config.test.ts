import { Keypair } from "@stellar/stellar-sdk";
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { describe, expect, it } from "vitest";
import { DemoConfigError, resolveDemoConfig } from "./config.js";

const recipient = Keypair.random().publicKey();
const secret = Keypair.random().secret();
const liveEnv = { OZ_API_KEY: "k", STELLAR_RECIPIENT: recipient, STELLAR_SECRET_KEY: secret };

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    resolveDemoConfig(env);
  } catch (error) {
    if (error instanceof DemoConfigError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error("expected resolveDemoConfig to throw a DemoConfigError");
}

describe("resolveDemoConfig", () => {
  it("needs nothing beyond MOCK_MODE=true in mock mode", () => {
    expect(resolveDemoConfig({ MOCK_MODE: "true" })).toEqual({ mode: "mock" });
  });

  it("defaults to the testnet facilitator for testnet", () => {
    const config = resolveDemoConfig(liveEnv);
    expect(config.mode).toBe("live");
    if (config.mode !== "live") return;

    expect(config.network).toBe("testnet");
    expect(config.facilitatorUrl).toBe("https://channels.openzeppelin.com/x402/testnet");
    expect(config.asset).toBe(USDC_TESTNET_ADDRESS);
    expect(config.apiKey).toBe("k");
    expect(config.recipient).toBe(recipient);
    expect(config.payerSecret).toBe(secret);
  });

  it("uses the mainnet facilitator and USDC address for mainnet", () => {
    const config = resolveDemoConfig({
      ...liveEnv,
      STELLAR_NETWORK: "mainnet",
      STELLAR_RPC_URL: "https://rpc.example.org",
    });
    expect(config.mode).toBe("live");
    if (config.mode !== "live") return;

    expect(config.facilitatorUrl).toBe("https://channels.openzeppelin.com/x402");
    expect(config.asset).toBe(USDC_PUBNET_ADDRESS);
    expect(config.rpcUrl).toBe("https://rpc.example.org");
  });

  it("lets FACILITATOR_URL override the default", () => {
    const config = resolveDemoConfig({ ...liveEnv, FACILITATOR_URL: "https://f.example.org" });
    expect(config.mode === "live" && config.facilitatorUrl).toBe("https://f.example.org");
  });

  it("reports every missing variable in live mode", () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("OZ_API_KEY");
    expect(problems[1]).toContain("STELLAR_RECIPIENT");
    expect(problems[2]).toContain("STELLAR_SECRET_KEY");
  });

  it("rejects an invalid STELLAR_RECIPIENT", () => {
    const problems = problemsOf({
      ...liveEnv,
      STELLAR_RECIPIENT: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
    expect(problems).toEqual([expect.stringContaining("STELLAR_RECIPIENT")]);
  });

  it("rejects a STELLAR_SECRET_KEY that is not an S... secret seed", () => {
    const problems = problemsOf({ ...liveEnv, STELLAR_SECRET_KEY: recipient });
    expect(problems).toEqual([expect.stringContaining("STELLAR_SECRET_KEY")]);
  });

  it("rejects an unknown STELLAR_NETWORK", () => {
    const problems = problemsOf({ ...liveEnv, STELLAR_NETWORK: "futurenet" });
    expect(problems).toEqual([expect.stringContaining("STELLAR_NETWORK")]);
  });

  it("needs STELLAR_RPC_URL on mainnet", () => {
    const problems = problemsOf({ ...liveEnv, STELLAR_NETWORK: "mainnet" });
    expect(problems).toEqual([expect.stringContaining("STELLAR_RPC_URL")]);
  });
});
