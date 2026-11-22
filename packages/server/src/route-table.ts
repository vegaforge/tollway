import { TollwayError } from "@vegaforge/tollway-core";
import { createInMemorySettlementCache } from "./cache.js";
import {
  createPaywallWithInFlight,
  type DynamicPriceFunction,
  type Gate,
  type InFlightSettlementResult,
  type PaywallConfig,
  type PaywallDeps,
  type TollwayRequest,
} from "./gate.js";
import { createInMemoryServicePolicyStore } from "./service-policy.js";

const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);

interface CompiledRoute {
  key: string;
  method: string;
  pattern: string;
  segments: string[];
  config: PaywallConfig;
  gate: Gate;
  prefixLength: number;
  staticSegments: number;
}

/** One configured paid route, as {@link RouteTable} lists it. */
export interface RouteTableEntry {
  key: string;
  method: string;
  pattern: string;
  amount: string | DynamicPriceFunction;
  asset: string;
  payTo: string;
  network: PaywallConfig["network"];
  resource?: string;
}

/** The gate for a matched request and the resource its receipt names. */
export interface RouteTableMatch {
  gate: Gate;
  /** Canonical concrete path used as the default receipt resource. */
  resource: string;
}

/**
 * Paid routes compiled once by {@link createRouteTable}. `match` finds the
 * gate for a request; `list` returns every configured route.
 */
export interface RouteTable {
  match(method: string, url: string): RouteTableMatch | undefined;
  list(): RouteTableEntry[];
}

/** Validates and compiles paid route configuration once. */
export function createRouteTable(
  routes: Record<string, PaywallConfig>,
  deps: PaywallDeps,
): RouteTable {
  const entries = Object.entries(routes).map(([key, config]) => compileEntry(key, config));
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalizedKey = `${entry.method} ${entry.pattern}`;
    if (seen.has(normalizedKey)) {
      throw new TollwayError("policy-blocked", `duplicate route entry: ${entry.key}`);
    }
    seen.add(normalizedKey);
  }
  for (let left = 0; left < entries.length; left++) {
    for (let right = left + 1; right < entries.length; right++) {
      const first = entries[left];
      const second = entries[right];
      if (first && second && first.method === second.method && overlapsAmbiguously(first, second)) {
        throw new TollwayError(
          "policy-blocked",
          `ambiguous route entries: ${first.key} and ${second.key}`,
        );
      }
    }
  }

  const sharedCache = deps.cache ?? createInMemorySettlementCache();
  const sharedServicePolicyStore =
    deps.servicePolicyStore ??
    (deps.servicePolicy ? createInMemoryServicePolicyStore() : undefined);
  const sharedDeps: PaywallDeps = {
    ...deps,
    cache: sharedCache,
    ...(sharedServicePolicyStore ? { servicePolicyStore: sharedServicePolicyStore } : {}),
  };
  const inFlight = new Map<string, Promise<InFlightSettlementResult>>();
  for (const entry of entries) {
    entry.gate = createPaywallWithInFlight(entry.config, sharedDeps, inFlight);
  }
  entries.sort(
    (first, second) =>
      second.prefixLength - first.prefixLength ||
      second.staticSegments - first.staticSegments ||
      second.segments.length - first.segments.length,
  );
  const publicEntries = entries.map(toPublicEntry);

  return {
    match(method, url) {
      const canonicalMethod = method.toUpperCase();
      const resource = normalizePath(url);
      const entry = entries.find(
        (candidate) => candidate.method === canonicalMethod && matches(candidate, resource),
      );
      if (!entry) return undefined;
      return {
        resource,
        gate: (request: TollwayRequest) =>
          entry.gate({ ...request, url: entry.config.resource ?? resource }),
      };
    },
    list() {
      return publicEntries.map((entry) => ({ ...entry }));
    },
  };
}

function compileEntry(key: string, config: PaywallConfig): CompiledRoute {
  const separator = key.indexOf(" ");
  const method = separator < 0 ? "" : key.slice(0, separator).toUpperCase();
  const rawPattern = separator < 0 ? "" : key.slice(separator + 1);
  if (!HTTP_METHODS.has(method)) {
    throw new TollwayError("policy-blocked", `unknown method in route entry: ${key}`);
  }
  const pattern = normalizePattern(rawPattern, key);
  if (typeof config.amount === "string" && !/^[0-9]+$/.test(config.amount)) {
    throw new TollwayError(
      "invalid-amount",
      `invalid amount in route entry ${key}: ${config.amount}`,
    );
  }
  const segments = pattern === "/" ? [] : pattern.slice(1).split("/");
  for (const segment of segments) {
    if (segment.startsWith(":") && !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new TollwayError("policy-blocked", `invalid parameter in route entry: ${key}`);
    }
    if (segment.includes(":") && !segment.startsWith(":")) {
      throw new TollwayError("policy-blocked", `invalid parameter in route entry: ${key}`);
    }
  }
  const firstParam = segments.findIndex((segment) => segment.startsWith(":"));
  const prefixLength =
    firstParam < 0 ? pattern.length + 1 : segments.slice(0, firstParam).join("/").length + 1;
  const staticSegments = segments.filter((segment) => !segment.startsWith(":")).length;
  return {
    key,
    method,
    pattern,
    segments,
    config: { ...config, ...(config.models === undefined ? {} : { models: [...config.models] }) },
    gate: async () => ({ kind: "rejected", status: 500, reason: "route table not initialized" }),
    prefixLength,
    staticSegments,
  };
}

function normalizePattern(path: string, key: string): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new TollwayError("policy-blocked", `invalid path pattern in route entry: ${key}`);
  }
  const normalized = normalizePath(path);
  return normalized;
}

function normalizePath(url: string): string {
  const pathname = url.split(/[?#]/, 1)[0] || "/";
  if (!pathname.startsWith("/")) {
    throw new TollwayError("policy-blocked", `request path must be absolute: ${pathname}`);
  }
  if (/%(?![0-9a-fA-F]{2})/.test(pathname)) {
    throw new TollwayError("policy-blocked", "request path contains invalid percent-encoding");
  }
  const encoded = pathname.replace(/%[0-9a-fA-F]{2}/g, (code) => {
    const character = String.fromCharCode(Number.parseInt(code.slice(1), 16));
    return /^[A-Za-z0-9\-._~]$/.test(character) ? character : code.toUpperCase();
  });
  return trimTrailingSlashes(encoded);
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

function matches(route: CompiledRoute, path: string): boolean {
  const pathSegments = path === "/" ? [] : path.slice(1).split("/");
  return (
    route.segments.length === pathSegments.length &&
    route.segments.every(
      (segment, index) => segment.startsWith(":") || segment === pathSegments[index],
    )
  );
}

function overlapsAmbiguously(first: CompiledRoute, second: CompiledRoute): boolean {
  if (first.segments.length !== second.segments.length) return false;
  const overlaps = first.segments.every((segment, index) => {
    const other = second.segments[index];
    return segment.startsWith(":") || other?.startsWith(":") || segment === other;
  });
  return (
    overlaps &&
    first.prefixLength === second.prefixLength &&
    first.staticSegments === second.staticSegments
  );
}

function toPublicEntry(route: CompiledRoute): RouteTableEntry {
  return {
    key: route.key,
    method: route.method,
    pattern: route.pattern,
    amount: route.config.amount,
    asset: route.config.asset,
    payTo: route.config.payTo,
    network: route.config.network,
    ...(route.config.resource === undefined ? {} : { resource: route.config.resource }),
  };
}
