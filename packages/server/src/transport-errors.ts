/**
 * Node fetch reports a connection that never reached the facilitator as a
 * TypeError whose cause chain carries one of these codes: the request was
 * never sent, so the facilitator cannot have acted on it. Every other
 * transport failure (a reset, a timeout, a 5xx answer) may have happened
 * after the facilitator received the request.
 */
const PRE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

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
  }
  return false;
}
