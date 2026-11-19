import { USDC_TESTNET_ADDRESS } from "@x402/stellar";

/**
 * Turns the environment into the example's configuration, or a list of
 * everything wrong with it. Pure, so the startup rules are tested without
 * Next.js, Redis or a network. The README's "Environment variables" section
 * documents each variable.
 */

export type ExampleEnv = Readonly<Record<string, string | undefined>>;

export type ExampleMode = "mock" | "testnet";

export type FacilitatorSettings =
  | { kind: "mock" }
  | {
      kind: "http";
      url: string;
      /** OpenZeppelin Channels API key, sent as a Bearer token. */
      apiKey: string;
    };

export type ExampleConfig = {
  mode: ExampleMode;
  /** True on a hosted deployment, where instances share nothing in memory. */
  deployed: boolean;
  /**
   * base64url Ed25519 private key (seed or PKCS#8). Undefined only in local
   * mock mode, where a key is generated per process.
   */
  receiptKey: string | undefined;
  receiptKeyId: string | undefined;
  /** Set exactly when the settlement cache lives in Redis. */
  redisUrl: string | undefined;
  facilitator: FacilitatorSettings;
  /** The account that receives payments (G...). */
  payTo: string;
  /** The USDC Soroban contract address (C...). */
  asset: string;
  network: "testnet";
};

/** Thrown when the configuration cannot start the service. Lists every problem. */
export class ExampleConfigError extends Error {
  override readonly name = "ExampleConfigError";
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`next-paid-api cannot start:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

/**
 * The OpenZeppelin Channels x402 facilitator on testnet, the same default
 * apps/demo uses (docs/adr/ADR-2026-10-29-demo-facilitator-defaults.md).
 */
export const TESTNET_FACILITATOR_URL = "https://channels.openzeppelin.com/x402/testnet";

/**
 * A real testnet account generated for this example, so the defaults are
 * valid on the wire. Its secret was discarded: set TOLLWAY_PAY_TO to an
 * account you control before taking real testnet payments.
 */
export const DEFAULT_TESTNET_PAY_TO = "GAZROBUPKYVOFI243ECZGJMZGVVZYORUE7IZ5J6T7LIXHAHNUQM6VPSW";

/** Testnet USDC, from @x402/stellar so it cannot drift from the facilitator's. */
export const DEFAULT_TESTNET_ASSET = USDC_TESTNET_ADDRESS;

// Shape checks only (prefix, alphabet, length). The facilitator validates
// the checksum when it builds the payment.
const ACCOUNT_ID = /^G[A-Z2-7]{55}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

function readFlag(name: string, value: string | undefined, problems: string[]): boolean {
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  problems.push(`${name} must be "true" or "false", got "${value}"`);
  return false;
}

export function resolveConfig(env: ExampleEnv): ExampleConfig {
  const problems: string[] = [];

  const modeValue = env.TOLLWAY_MODE || "mock";
  if (modeValue !== "mock" && modeValue !== "testnet") {
    problems.push(`TOLLWAY_MODE must be "mock" or "testnet", got "${modeValue}"`);
  }
  const mode: ExampleMode = modeValue === "testnet" ? "testnet" : "mock";
  const deployed = readFlag("TOLLWAY_DEPLOYED", env.TOLLWAY_DEPLOYED, problems);

  // Outside local mock mode the key must be stable across instances, so it
  // has to come from configuration. Generating one here would make receipts
  // from different instances verify against different keys.
  const receiptKey = env.TOLLWAY_RECEIPT_KEY || undefined;
  if (!receiptKey && (mode === "testnet" || deployed)) {
    problems.push(
      "TOLLWAY_RECEIPT_KEY is not set. Generate one as described in the README, section 'Receipt key'",
    );
  }

  // Retries of one payment can reach different instances, so a deployment
  // needs the shared cache and its cross-process lock to settle only once.
  const redisUrl = env.REDIS_URL || undefined;
  if (deployed && !redisUrl) {
    problems.push(
      "REDIS_URL is not set. A deployment needs Redis so a payment settles once across instances",
    );
  }

  let facilitator: FacilitatorSettings = { kind: "mock" };
  if (mode === "testnet") {
    const apiKey = env.OZ_API_KEY ?? "";
    if (!apiKey) {
      problems.push(
        "OZ_API_KEY is not set. Generate a testnet key at https://channels.openzeppelin.com/testnet/gen",
      );
    }
    facilitator = { kind: "http", url: env.FACILITATOR_URL || TESTNET_FACILITATOR_URL, apiKey };
  }

  const payTo = env.TOLLWAY_PAY_TO || DEFAULT_TESTNET_PAY_TO;
  if (!ACCOUNT_ID.test(payTo)) {
    problems.push("TOLLWAY_PAY_TO is not a Stellar account id (G..., 56 characters)");
  }
  const asset = env.TOLLWAY_ASSET || DEFAULT_TESTNET_ASSET;
  if (!CONTRACT_ID.test(asset)) {
    problems.push("TOLLWAY_ASSET is not a Soroban contract address (C..., 56 characters)");
  }

  if (problems.length > 0) {
    throw new ExampleConfigError(problems);
  }

  return {
    mode,
    deployed,
    receiptKey,
    receiptKeyId: env.TOLLWAY_RECEIPT_KEY_ID || undefined,
    redisUrl,
    facilitator,
    payTo,
    asset,
    network: "testnet",
  };
}
