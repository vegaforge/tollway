import { classify, DecodeError, decodeValue } from "./decode.js";

/**
 * Sends one unpaid request and explains the 402 that comes back. It never
 * signs or pays: there is no option to pass a key.
 */

/**
 * The header names the gate uses. They are written out here rather than
 * imported, because loading @vegaforge/tollway-server pulls in the Stellar
 * SDK and costs seconds of startup; a test checks they match the server's.
 */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const TOLLWAY_QUOTE_HEADER = "TOLLWAY-QUOTE";

export type InspectOptions = {
  method?: string;
  headers?: Record<string, string>;
  /** Milliseconds for the whole exchange, redirects included. */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type ChallengeOption = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
};

export type InspectResult =
  | {
      paid: true;
      status: 402;
      url: string;
      resource: string | undefined;
      /** Every option the 402 accepts, in the service's order. */
      accepts: ChallengeOption[];
      /** Settlement models the challenge offers: x402, and mpp-charge when MPP is offered too. */
      models: string[];
      /** A facilitator the challenge names, if it names one. */
      facilitator: string | undefined;
      quoted: boolean;
    }
  | { paid: false; status: number; url: string };

export class InspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectError";
  }
}

const MAX_REDIRECTS = 5;
/** The 402 body is only read when the header is missing, and only this much of it. */
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new InspectError(`the 402 body is larger than ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Follows a redirect only to the same origin. A redirect to another origin
 * is refused rather than followed, so `inspect` never sends the operator's
 * headers somewhere they did not name.
 */
async function fetchSameOrigin(
  url: URL,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<{ response: Response; url: URL }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetcher(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return { response, url: current };
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null) return { response, url: current };
    const next = new URL(location, current);
    if (next.origin !== url.origin) {
      throw new InspectError(
        `${current} redirects to another origin (${next.origin}); not following it`,
      );
    }
    current = next;
  }
  throw new InspectError(`more than ${MAX_REDIRECTS} redirects`);
}

function offersMpp(response: Response): boolean {
  const header = response.headers.get("www-authenticate") ?? "";
  return /(^|,)\s*Payment\b/i.test(header);
}

export async function inspect(
  target: string,
  options: InspectOptions = {},
): Promise<InspectResult> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new InspectError(`${target} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InspectError(`only http and https URLs can be inspected, not ${url.protocol}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let exchange: { response: Response; url: URL };
  try {
    exchange = await fetchSameOrigin(
      url,
      { method: options.method ?? "GET", headers: options.headers ?? {}, signal },
      options.fetch ?? globalThis.fetch,
    );
  } catch (error) {
    if (error instanceof InspectError) throw error;
    if (signal.aborted) throw new InspectError(`no answer from ${url} within ${timeoutMs} ms`);
    const reason = error instanceof Error ? error.message : String(error);
    throw new InspectError(`could not reach ${url}: ${reason}`);
  }
  const { response } = exchange;
  if (response.status !== 402) {
    await response.body?.cancel();
    return { paid: false, status: response.status, url: exchange.url.toString() };
  }

  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  let decoded: { shape: string; value: unknown };
  if (header === null) {
    // Some services send the challenge only as the JSON body.
    const body = await readCapped(response);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new InspectError("the 402 has no PAYMENT-REQUIRED header and its body is not JSON");
    }
    decoded = classify(json);
  } else {
    await response.body?.cancel();
    decoded = decodeValue(header);
  }
  if (decoded.shape !== "x402-payment-required") {
    throw new DecodeError("the 402's challenge is not an x402 PaymentRequired");
  }
  const challenge = decoded.value as {
    resource?: { url?: string };
    accepts: Array<ChallengeOption & { extra?: Record<string, unknown> }>;
  };
  const facilitator = challenge.accepts
    .map((option) => option.extra?.facilitator ?? option.extra?.facilitatorUrl)
    .find((value): value is string => typeof value === "string");
  return {
    paid: true,
    status: 402,
    url: exchange.url.toString(),
    resource: challenge.resource?.url,
    accepts: challenge.accepts.map(
      ({ scheme, network, amount, asset, payTo, maxTimeoutSeconds }) => ({
        scheme,
        network,
        amount,
        asset,
        payTo,
        maxTimeoutSeconds,
      }),
    ),
    models: offersMpp(response) ? ["x402", "mpp-charge"] : ["x402"],
    facilitator,
    quoted: response.headers.has(TOLLWAY_QUOTE_HEADER),
  };
}
