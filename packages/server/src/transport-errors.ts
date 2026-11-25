/**
 * Errors that prove a facilitator request was never sent, so the facilitator
 * cannot have acted on it. Every other transport failure (a reset, a
 * timeout, a 5xx answer) may have happened after the facilitator received
 * the request. Each runtime words this differently:
 *
 * - Node: a `TypeError("fetch failed")` whose cause carries `ECONNREFUSED`,
 *   `ENOTFOUND` or `EAI_AGAIN`.
 * - Deno: a `TypeError("fetch failed")` whose cause message says the TCP
 *   connect or the DNS lookup failed.
 * - Bun: an `Error` with code `ConnectionRefused`.
 * - workerd: `Network connection lost.` for a refusal and a reset alike, so
 *   it is never treated as pre-send.
 */
const PRE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"]);
const PRE_SEND_MESSAGES = /\b(tcp connect error|dns error|failed to lookup address)\b/i;

/**
 * True when an error from a facilitator call proves the request was never
 * sent. Walks the cause chain, because fetch and the facilitator client each
 * wrap the network error. Anything else is treated as "may have been
 * received": for `/settle` that means the payment may land.
 */
export function isPreSendFailure(error: unknown): boolean {
  for (let cursor: unknown = error; cursor; cursor = (cursor as { cause?: unknown }).cause) {
    if (!(cursor instanceof Error)) return false;
    const code = (cursor as Error & { code?: unknown }).code;
    if (typeof code === "string" && PRE_SEND_CODES.has(code)) return true;
    if (PRE_SEND_MESSAGES.test(cursor.message)) return true;
  }
  return false;
}

const TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  // Bun's names for the same conditions.
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
]);

/**
 * How each runtime's fetch says the request did not complete: Node, Deno
 * and browsers throw a `TypeError` with one of these messages; workerd
 * throws a plain `Error` saying the connection was lost.
 */
const FETCH_FAILURE_TYPE_ERROR =
  /^(fetch failed|failed to fetch|load failed|networkerror when attempting to fetch resource)/i;
const WORKERD_CONNECTION_LOST = /^network connection lost\.?$/i;

/**
 * True for errors raised by the HTTP layer rather than by the other side
 * judging the request: axios errors (stellar-sdk's RPC client), a failed
 * fetch on any runtime, aborts and timeouts, and socket error codes.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("isAxiosError" in error && error.isAxiosError === true) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error instanceof TypeError && FETCH_FAILURE_TYPE_ERROR.test(error.message)) return true;
  if (WORKERD_CONNECTION_LOST.test(error.message)) return true;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && TRANSPORT_ERROR_CODES.has(code);
}
