import { Networks, type rpc } from "@stellar/stellar-sdk";
import { errorMessage } from "./tls-proxy.js";

/** Time between readiness probes. Short, because a local ledger closes every second. */
const POLL_INTERVAL_MS = 500;

/**
 * The passphrase the local network must use. `@x402/stellar` and
 * `@stellar/mpp` only know `stellar:testnet` and `stellar:pubnet` and sign
 * with the matching passphrase, so the quickstart container is started with
 * `NETWORK_PASSPHRASE` set to the testnet one (see docs/local-network-tests.md).
 */
export const LOCAL_NETWORK_PASSPHRASE = Networks.TESTNET;

/**
 * Polls RPC `getHealth` until the node reports healthy, then checks the
 * network passphrase. Throws a message naming the URL and the deadline when
 * the node does not become healthy in time, with the last error seen.
 */
export async function waitForHealthyRpc(
  server: rpc.Server,
  options: { label: string; deadlineMs: number },
): Promise<rpc.Api.GetNetworkResponse> {
  const deadline = Date.now() + options.deadlineMs;
  let lastProblem = "no response yet";
  while (Date.now() < deadline) {
    try {
      const health = await withDeadline(server.getHealth(), deadline);
      if (health.status === "healthy") {
        return await checkPassphrase(server, options.label, deadline);
      }
      lastProblem = `status ${String(health.status)}`;
    } catch (error) {
      if (error instanceof WrongNetworkError) throw error;
      // A refused connection or a 503 is expected while the container boots.
      // Keep the cause for the timeout message and try again.
      lastProblem = errorMessage(error);
    }
    await sleepUntilNextPoll(deadline);
  }
  throw new Error(
    `local Stellar RPC at ${options.label} was not healthy within ${options.deadlineMs} ms ` +
      `(last result: ${lastProblem}). Is the stellar/quickstart container running with --local ` +
      "(NETWORK=local) and RPC enabled?",
  );
}

class WrongNetworkError extends Error {}

async function checkPassphrase(
  server: rpc.Server,
  label: string,
  deadline: number,
): Promise<rpc.Api.GetNetworkResponse> {
  const network = await withDeadline(server.getNetwork(), deadline);
  if (network.passphrase !== LOCAL_NETWORK_PASSPHRASE) {
    throw new WrongNetworkError(
      `local Stellar RPC at ${label} runs "${network.passphrase}", but the x402 and MPP SDKs ` +
        `only sign for "${LOCAL_NETWORK_PASSPHRASE}". Start quickstart with ` +
        `NETWORK_PASSPHRASE="${LOCAL_NETWORK_PASSPHRASE}".`,
    );
  }
  return network;
}

/**
 * Runs `operation` again until it succeeds or the deadline passes. Used for
 * friendbot, which can come up a little after RPC reports healthy.
 */
export async function retryUntil<T>(
  what: string,
  deadline: number,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      return await withDeadline(operation(), deadline);
    } catch (error) {
      lastError = error;
    }
    await sleepUntilNextPoll(deadline);
  }
  throw new Error(`${what} did not succeed before the deadline: ${errorMessage(lastError)}`);
}

/** Rejects when the deadline passes, so one hung request cannot outlive it. */
function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("request did not answer before the deadline")),
      Math.max(0, deadline - Date.now()),
    );
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function sleepUntilNextPoll(deadline: number): Promise<void> {
  const wait = Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
  return new Promise((resolve) => setTimeout(resolve, wait));
}
