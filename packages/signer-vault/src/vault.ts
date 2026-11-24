import { TollwayError } from "@vegaforge/tollway-core";
import { z } from "zod";

/**
 * A minimal client for the two Vault Transit endpoints the signer needs. It
 * uses `fetch` only, so it runs wherever the gate runs, and it never puts
 * the Vault token in an error message.
 */

/** Why a Vault call failed. Stable, so callers can branch on it. */
export type VaultFailureKind =
  | "sealed"
  | "permission-denied"
  | "key-missing"
  | "bad-request"
  | "server-error"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "invalid-response"
  | "version-mismatch"
  | "unsupported-key-type";

/**
 * Thrown for every failure the signer can see. `requestId` is Vault's
 * `request_id` when the response carried one; `status` is the HTTP status
 * when there was a response at all.
 */
export class VaultTransitError extends TollwayError {
  readonly kind: VaultFailureKind;
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    kind: VaultFailureKind,
    message: string,
    details: { status?: number; requestId?: string; cause?: unknown } = {},
  ) {
    super(
      kind === "unsupported-key-type" ? "invalid-signing-key" : "signer-failed",
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "VaultTransitError";
    this.kind = kind;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

export type VaultTokenSource = string | (() => string | Promise<string>);

export type VaultRequestOptions = {
  /** Vault's address, for example `https://vault.internal:8200`. */
  address: string;
  token: VaultTokenSource;
  /** Enterprise namespace, sent as `X-Vault-Namespace`. */
  namespace?: string;
  /** Milliseconds before a single request is abandoned. */
  timeoutMs: number;
  /** Aborts every request the signer makes. */
  signal?: AbortSignal;
  fetch: typeof fetch;
};

const errorBodySchema = z.object({ errors: z.array(z.string()).optional() });
const requestIdSchema = z.object({ request_id: z.string().optional() });

async function resolveToken(source: VaultTokenSource): Promise<string> {
  const token = typeof source === "string" ? source : await source();
  if (token.length === 0) {
    throw new VaultTransitError("permission-denied", "the Vault token is empty");
  }
  return token;
}

/** Removes every occurrence of the token, in case Vault ever echoes it back. */
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("[redacted]") : text;
}

function kindForStatus(status: number, messages: readonly string[]): VaultFailureKind {
  if (status === 503 && messages.some((message) => /sealed/i.test(message))) return "sealed";
  if (status === 403) return "permission-denied";
  if (status === 404) return "key-missing";
  if (status === 400) return "bad-request";
  if (status >= 500) return "server-error";
  return "bad-request";
}

/**
 * Sends one request to Vault and returns the parsed JSON body. Every failure
 * becomes a {@link VaultTransitError}; the token never appears in one.
 */
export async function vaultRequest(
  options: VaultRequestOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ json: unknown; requestId: string | undefined }> {
  const token = await resolveToken(options.token);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { "X-Vault-Token": token };
  if (options.namespace !== undefined) headers["X-Vault-Namespace"] = options.namespace;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const url = `${options.address.replace(/\/+$/, "")}/v1/${path}`;

  let response: Response;
  try {
    signal.throwIfAborted();
    // Raced against the signal as well as passed to fetch, so a fetch that
    // ignores its signal still cannot hold the signer past the deadline.
    response = await Promise.race([
      options.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: "error",
      }),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch (error) {
    if (options.signal?.aborted) {
      throw new VaultTransitError("aborted", `the Vault request to ${path} was aborted`, {
        cause: error,
      });
    }
    if (timeout.aborted) {
      throw new VaultTransitError(
        "timeout",
        `the Vault request to ${path} took longer than ${options.timeoutMs} ms`,
        { cause: error },
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new VaultTransitError(
      "unavailable",
      `could not reach Vault for ${path}: ${redact(reason, token)}`,
      { cause: error },
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (!response.ok) {
      throw new VaultTransitError(
        kindForStatus(response.status, []),
        `Vault answered ${path} with ${response.status}`,
        { status: response.status },
      );
    }
    throw new VaultTransitError(
      "invalid-response",
      `Vault answered ${path} with a body that is not JSON`,
      { status: response.status, cause: error },
    );
  }
  const requestId = requestIdSchema.safeParse(json).data?.request_id;

  if (!response.ok) {
    const messages = errorBodySchema.safeParse(json).data?.errors ?? [];
    const detail = messages.length > 0 ? `: ${redact(messages.join("; "), token)}` : "";
    throw new VaultTransitError(
      kindForStatus(response.status, messages),
      `Vault answered ${path} with ${response.status}${detail}`,
      { status: response.status, ...(requestId === undefined ? {} : { requestId }) },
    );
  }
  return { json, requestId };
}
