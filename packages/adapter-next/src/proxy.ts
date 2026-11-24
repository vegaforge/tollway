import {
  base64UrlToBytes,
  type SignedReceipt,
  signedReceiptSchema,
  TollwayError,
} from "@vegaforge/tollway-core";
import type { Gate, TollwayRequest } from "@vegaforge/tollway-server";
import {
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@vegaforge/tollway-server";
// The explicit `.js` lets plain Node ESM resolve it: `next` publishes no
// export map, so `next/server` alone only resolves under a bundler.
import { type NextRequest, NextResponse } from "next/server.js";

/** Header used only between a configured Next proxy and its route handler. */
export const PROXY_RECEIPT_HEADER = "x-tollway-proxy-receipt";

export interface ProxyRoute {
  /** Exact path or path prefix. A prefix matches only on a segment boundary. */
  path: string;
  gate: Gate;
  /** Defaults to every HTTP method. Values are compared case-insensitively. */
  methods?: readonly string[];
}

export interface PaywallProxyConfig {
  routes: readonly ProxyRoute[];
}

/**
 * Reads the receipt attached by `paywallProxy`. Missing receipt means the
 * request was not paid through that proxy. Invalid values throw a TollwayError.
 */
export function getProxyReceipt(request: Request): SignedReceipt | undefined {
  const encoded = request.headers.get(PROXY_RECEIPT_HEADER);
  if (encoded === null) return undefined;

  let candidate: unknown;
  try {
    if (encoded.length > 65_536) throw new Error("header exceeds the 64 KiB limit");
    candidate = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch (error) {
    throw new TollwayError(
      "invalid-receipt",
      `proxy receipt header is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError(
      "invalid-receipt",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

/**
 * Builds the handler for a Next.js 16 `proxy.ts`. It uses Next's documented
 * `NextResponse.next({ request: { headers } })` override to pass the gate's
 * receipt only to the downstream route handler.
 */
export function paywallProxy(
  config: PaywallProxyConfig,
): (request: NextRequest) => Promise<Response> {
  const routes = config.routes.map((route) => ({ ...route, path: normalizePath(route.path) }));
  for (let left = 0; left < routes.length; left++) {
    for (let right = left + 1; right < routes.length; right++) {
      const first = routes[left];
      const second = routes[right];
      if (
        first &&
        second &&
        first.path === second.path &&
        methodsOverlap(first.methods, second.methods)
      ) {
        throw new TypeError(`Duplicate proxy route configuration for ${first.path}`);
      }
    }
  }
  routes.sort((left, right) => right.path.length - left.path.length);

  return async (request: NextRequest): Promise<Response> => {
    assertProxyRuntime();
    const sanitizedHeaders = new Headers(request.headers);
    sanitizedHeaders.delete(PROXY_RECEIPT_HEADER);
    const sanitizedRequest = new Request(request, { headers: sanitizedHeaders });
    const route = routes.find(
      (candidate) =>
        pathMatches(new URL(request.url).pathname, candidate.path) &&
        (!candidate.methods ||
          candidate.methods.some(
            (method) => method.toUpperCase() === request.method.toUpperCase(),
          )),
    );
    if (!route) return NextResponse.next({ request: { headers: sanitizedHeaders } });

    const outcome = await route.gate(toTollwayRequest(sanitizedRequest));
    if (outcome.kind === "payment-required") {
      return jsonResponse(outcome.challenge, outcome.status, outcome.headers);
    }
    if (outcome.kind === "rejected") {
      return jsonResponse({ error: outcome.reason }, outcome.status);
    }

    const forwardedHeaders = new Headers(sanitizedHeaders);
    forwardedHeaders.set(PROXY_RECEIPT_HEADER, encodeHeader(outcome.receipt));
    return NextResponse.next({
      headers: outcome.headers,
      request: { headers: forwardedHeaders },
    });
  };
}

export function assertProxyRuntime(runtime = readRuntime()): void {
  if (runtime !== undefined && runtime !== "nodejs") {
    throw new Error(
      `Tollway paywallProxy requires the Next.js Node.js runtime; received ${runtime}. Next.js 16 Proxy uses Node.js by default.`,
    );
  }
}

function readRuntime(): string | undefined {
  return typeof process === "undefined" ? undefined : process.env.NEXT_RUNTIME;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new TypeError(`Proxy route path must be an absolute pathname: ${path}`);
  }
  return trimTrailingSlashes(path);
}

/**
 * Drops trailing slashes in one pass. A regex like /\/+$/ backtracks on a
 * long run of slashes that is not at the end, which made this quadratic on
 * hostile input.
 */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

function methodsOverlap(first?: readonly string[], second?: readonly string[]): boolean {
  if (!first || !second) return true;
  return first.some((method) =>
    second.some((other) => method.toUpperCase() === other.toUpperCase()),
  );
}

function pathMatches(pathname: string, prefix: string): boolean {
  return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function toTollwayRequest(request: Request): TollwayRequest {
  const headers: TollwayRequest["headers"] = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const url = new URL(request.url);
  return { method: request.method, url: `${url.pathname}${url.search}`, headers };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  return new NextResponse(JSON.stringify(body), { status, headers: responseHeaders });
}

// Keep these names visible to consumers that build a proxy configuration.
export { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER };
