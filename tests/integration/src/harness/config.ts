/**
 * Settings for the local-network suite, read once from the environment.
 *
 * Only infrastructure is configured here: where the node is and how to reach
 * it over TLS. Keys are never read from the environment; every account is
 * `Keypair.random()` per run (see `local-network.ts`).
 */

/** The suite runs only when this is "true"; `pnpm test` without Docker skips it. */
export const LOCAL_STELLAR_ENABLED = process.env.TOLLWAY_LOCAL_STELLAR === "true";

/** Where `stellar/quickstart` serves Stellar RPC when its port 8000 is published. */
const DEFAULT_UPSTREAM_RPC_URL = "http://localhost:8000/rpc";

/**
 * How long a fresh quickstart container may take to report healthy and fund
 * accounts. A local network usually needs well under a minute; the margin
 * covers a cold CI runner.
 */
const DEFAULT_READY_TIMEOUT_MS = 180_000;

export type LocalStellarConfig = {
  /** Plain-HTTP RPC endpoint of the quickstart container. */
  upstreamRpcUrl: string;
  /** PEM certificate and key the HTTPS proxy in front of the RPC serves. */
  tlsCertPath: string;
  tlsKeyPath: string;
  /** Deadline for readiness and for friendbot funding, in milliseconds. */
  readyTimeoutMs: number;
};

type Env = Record<string, string | undefined>;

/**
 * Reads the suite's settings. Throws with the variable to set when one is
 * missing or malformed, so a misconfigured run fails before any network call.
 */
export function readLocalStellarConfig(env: Env = process.env): LocalStellarConfig {
  const tlsCertPath = env.TOLLWAY_LOCAL_STELLAR_TLS_CERT;
  const tlsKeyPath = env.TOLLWAY_LOCAL_STELLAR_TLS_KEY;
  if (!tlsCertPath || !tlsKeyPath) {
    throw new Error(
      "TOLLWAY_LOCAL_STELLAR_TLS_CERT and TOLLWAY_LOCAL_STELLAR_TLS_KEY must name a PEM certificate " +
        "and key for localhost, and NODE_EXTRA_CA_CERTS must name the same certificate. " +
        "See docs/local-network-tests.md.",
    );
  }
  return {
    upstreamRpcUrl: env.TOLLWAY_LOCAL_STELLAR_RPC_URL ?? DEFAULT_UPSTREAM_RPC_URL,
    tlsCertPath,
    tlsKeyPath,
    readyTimeoutMs: readPositiveInteger(
      env,
      "TOLLWAY_LOCAL_STELLAR_READY_TIMEOUT_MS",
      DEFAULT_READY_TIMEOUT_MS,
    ),
  };
}

function readPositiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds, got "${raw}"`);
  }
  return value;
}
