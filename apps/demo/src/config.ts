import { StrKey } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@tollway/core";
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";

/**
 * Turns the demo's environment into a config, or a list of what is wrong
 * with it. Pure, so it is tested without a network. See
 * docs/adr/ADR-2026-10-29-demo-facilitator-defaults.md.
 */

export type DemoEnv = Readonly<Record<string, string | undefined>>;

export type LiveDemoConfig = {
  mode: "live";
  network: StellarNetwork;
  facilitatorUrl: string;
  /** OpenZeppelin Channels API key, sent as a Bearer token. */
  apiKey: string;
  /** The USDC Soroban contract address (C...) for the network. */
  asset: string;
  /** The account that receives the payment (G...). */
  recipient: string;
  /** The paying account's secret seed (S...). Use a testnet key. */
  payerSecret: string;
  /** Soroban RPC used to build the payment. Required on mainnet. */
  rpcUrl: string | undefined;
};

export type DemoConfig = { mode: "mock" } | LiveDemoConfig;

/** Thrown when live mode is missing settings. `problems` lists every one. */
export class DemoConfigError extends Error {
  override readonly name = "DemoConfigError";
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`demo configuration is incomplete:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

const FACILITATOR_URLS: Record<StellarNetwork, string> = {
  testnet: "https://channels.openzeppelin.com/x402/testnet",
  mainnet: "https://channels.openzeppelin.com/x402",
};

const USDC_ADDRESSES: Record<StellarNetwork, string> = {
  testnet: USDC_TESTNET_ADDRESS,
  mainnet: USDC_PUBNET_ADDRESS,
};

function isStellarNetwork(value: string): value is StellarNetwork {
  return value === "testnet" || value === "mainnet";
}

export function resolveDemoConfig(env: DemoEnv): DemoConfig {
  if (env.MOCK_MODE === "true") {
    return { mode: "mock" };
  }

  const problems: string[] = [];

  const networkValue = env.STELLAR_NETWORK ?? "testnet";
  if (!isStellarNetwork(networkValue)) {
    problems.push(`STELLAR_NETWORK must be "testnet" or "mainnet", got "${networkValue}"`);
  }
  const network: StellarNetwork = isStellarNetwork(networkValue) ? networkValue : "testnet";

  const apiKey = env.OZ_API_KEY ?? "";
  if (!apiKey) {
    problems.push(
      "OZ_API_KEY is not set. Generate a testnet key at https://channels.openzeppelin.com/testnet/gen",
    );
  }

  const recipient = env.STELLAR_RECIPIENT ?? "";
  if (!recipient) {
    problems.push("STELLAR_RECIPIENT is not set. It is the G... account that receives the payment");
  } else if (!StrKey.isValidEd25519PublicKey(recipient)) {
    problems.push("STELLAR_RECIPIENT is not a valid Stellar account id (G...)");
  }

  const payerSecret = env.STELLAR_SECRET_KEY ?? "";
  if (!payerSecret) {
    problems.push(
      "STELLAR_SECRET_KEY is not set. It is the S... secret of a testnet account holding USDC",
    );
  } else if (!StrKey.isValidEd25519SecretSeed(payerSecret)) {
    problems.push("STELLAR_SECRET_KEY is not a valid Stellar secret seed (S...)");
  }

  const rpcUrl = env.STELLAR_RPC_URL || undefined;
  if (network === "mainnet" && !rpcUrl) {
    problems.push("STELLAR_RPC_URL is required on mainnet; @x402/stellar has no mainnet default");
  }

  if (problems.length > 0) {
    throw new DemoConfigError(problems);
  }

  return {
    mode: "live",
    network,
    facilitatorUrl: env.FACILITATOR_URL || FACILITATOR_URLS[network],
    apiKey,
    asset: USDC_ADDRESSES[network],
    recipient,
    payerSecret,
    rpcUrl,
  };
}
