import type { StellarNetwork } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";
import {
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  STELLAR_WILDCARD_CAIP2,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "@x402/stellar";
import { z } from "zod";
import type { FacilitatorClient } from "./facilitator.js";
import type { PaywallConfig } from "./gate.js";

/**
 * The x402 scheme @x402/stellar implements; see `ExactStellarScheme.scheme`.
 * Repeated here rather than imported from facilitator.ts, which imports this
 * module.
 */
const STELLAR_EXACT_SCHEME = "exact";

/** The x402 wire version the gate speaks (ADR-2026-11-17). */
const EXPECTED_X402_VERSION = 2;

/** One (version, scheme, network) combination a facilitator can settle. */
export type FacilitatorKind = {
  x402Version: number;
  scheme: string;
  /** A CAIP-2 network id, or a wildcard such as `stellar:*`. */
  network: string;
  /** Scheme-specific data, for example `{ areFeesSponsored: true }` for Stellar `exact`. */
  extra?: Record<string, unknown>;
};

/**
 * Everything an x402 facilitator advertises on `/supported`: the kinds it
 * settles, the extensions it understands, and its signer addresses per
 * network.
 *
 * There is no asset list. x402 `/supported` does not say which tokens a
 * facilitator accepts, so asset acceptance is only confirmed by the first
 * `/verify`.
 */
export type FacilitatorCapabilities = {
  kinds: FacilitatorKind[];
  extensions: string[];
  signers: Record<string, string[]>;
};

const kindSchema = z.object({
  x402Version: z.number().int().positive(),
  scheme: z.string().min(1),
  network: z.string().min(1),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const capabilitiesSchema = z.object({
  kinds: z.array(kindSchema),
  extensions: z.array(z.string()).default([]),
  signers: z.record(z.string(), z.array(z.string())).default({}),
});

/**
 * Parses a `/supported` response read from the wire into Tollway's type.
 *
 * Throws `TollwayError("facilitator-invalid-response")` naming the first
 * offending field. A malformed entry is refused rather than dropped, so a
 * lossy response cannot pass as a smaller valid one.
 */
export function parseFacilitatorCapabilities(raw: unknown): FacilitatorCapabilities {
  const parsed = capabilitiesSchema.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "response";
    throw new TollwayError(
      "facilitator-invalid-response",
      `facilitator /supported ${path} is invalid: ${issue?.message ?? "unknown error"}`,
    );
  }
  const { kinds, extensions, signers } = parsed.data;
  return {
    kinds: kinds.map(({ x402Version, scheme, network, extra }) =>
      extra === undefined
        ? { x402Version, scheme, network }
        : { x402Version, scheme, network, extra },
    ),
    extensions,
    signers,
  };
}

/**
 * The part of a paywall the capability check reads. A `PaywallConfig` fits
 * as is.
 */
export type PaywallTarget = Pick<PaywallConfig, "asset" | "payTo" | "network" | "models" | "extra">;

/**
 * One field where a paywall and the facilitator disagree. `expected` is
 * what the paywall needs and `advertised` is what the facilitator offers
 * (or, for `asset` and `payTo`, the value the paywall set).
 */
export type PaywallMismatch = {
  route: string;
  field: "x402Version" | "scheme" | "network" | "extra.areFeesSponsored" | "asset" | "payTo";
  expected: string;
  advertised: string;
};

/** The result of checking one paywall against a facilitator's capabilities. */
export type PaywallValidation =
  | { status: "valid" }
  | { status: "mismatch"; mismatches: PaywallMismatch[] }
  | { status: "not-applicable"; reason: string };

const NETWORK_CAIP2: Record<StellarNetwork, string> = {
  testnet: STELLAR_TESTNET_CAIP2,
  mainnet: STELLAR_PUBNET_CAIP2,
};

function listOrNone(values: Iterable<string>): string {
  const joined = Array.from(new Set(values)).join(",");
  return joined === "" ? "none" : joined;
}

function describeFlag(value: unknown): string {
  return value === undefined ? "unset" : String(value);
}

/**
 * The kind a facilitator would use to settle x402 on a Stellar network: x402
 * version 2, the `exact` scheme, and the network's CAIP-2 id or `stellar:*`.
 * Undefined when the facilitator cannot settle that network. The failover
 * client uses it to decide which facilitators are eligible for a payment.
 */
export function findMatchingKind(
  capabilities: FacilitatorCapabilities,
  network: StellarNetwork,
): FacilitatorKind | undefined {
  const expectedNetwork = NETWORK_CAIP2[network];
  return capabilities.kinds.find(
    (kind) =>
      kind.x402Version === EXPECTED_X402_VERSION &&
      kind.scheme === STELLAR_EXACT_SCHEME &&
      (kind.network === expectedNetwork || kind.network === STELLAR_WILDCARD_CAIP2),
  );
}

/**
 * Checks one paywall against a facilitator's capabilities and returns every
 * mismatch:
 *
 * - x402 version 2 is offered;
 * - `exact` is offered for the paywall's CAIP-2 network or `stellar:*`;
 * - the paywall's `extra.areFeesSponsored` equals the matching kind's. The
 *   @x402/stellar client refuses to pay unless they agree, so an unset value
 *   on either side is a mismatch when the other side sets it;
 * - `asset` is a Stellar contract address (not `CODE:ISSUER`) and `payTo` a
 *   valid destination, which the Stellar facilitator compares on-chain.
 *
 * Only x402 is checked. MPP charge settles without a facilitator, so a
 * paywall that does not offer x402 is `not-applicable`.
 */
export function validatePaywall(
  route: string,
  paywall: PaywallTarget,
  capabilities: FacilitatorCapabilities,
): PaywallValidation {
  if (!(paywall.models ?? ["x402"]).includes("x402")) {
    return {
      status: "not-applicable",
      reason: "the paywall does not offer x402, the only model a facilitator settles",
    };
  }

  const mismatches: PaywallMismatch[] = [];
  const expectedNetwork = NETWORK_CAIP2[paywall.network];
  const v2 = capabilities.kinds.filter((kind) => kind.x402Version === EXPECTED_X402_VERSION);
  const v2Exact = v2.filter((kind) => kind.scheme === STELLAR_EXACT_SCHEME);

  if (v2.length === 0) {
    mismatches.push({
      route,
      field: "x402Version",
      expected: String(EXPECTED_X402_VERSION),
      advertised: listOrNone(capabilities.kinds.map((kind) => String(kind.x402Version))),
    });
  } else if (v2Exact.length === 0) {
    mismatches.push({
      route,
      field: "scheme",
      expected: STELLAR_EXACT_SCHEME,
      advertised: listOrNone(v2.map((kind) => kind.scheme)),
    });
  }

  const matchingKind = findMatchingKind(capabilities, paywall.network);
  if (v2Exact.length > 0 && !matchingKind) {
    mismatches.push({
      route,
      field: "network",
      expected: `${expectedNetwork} or ${STELLAR_WILDCARD_CAIP2}`,
      advertised: listOrNone(v2Exact.map((kind) => kind.network)),
    });
  }

  if (matchingKind) {
    const wanted = paywall.extra?.areFeesSponsored;
    const offered = matchingKind.extra?.areFeesSponsored;
    if (wanted !== offered) {
      mismatches.push({
        route,
        field: "extra.areFeesSponsored",
        expected: describeFlag(wanted),
        advertised: describeFlag(offered),
      });
    }
  }

  if (!validateStellarAssetAddress(paywall.asset)) {
    mismatches.push({
      route,
      field: "asset",
      expected: "a Stellar contract address (C...)",
      advertised: paywall.asset,
    });
  }

  if (!validateStellarDestinationAddress(paywall.payTo)) {
    mismatches.push({
      route,
      field: "payTo",
      expected: "a Stellar destination (G..., M... or C...)",
      advertised: paywall.payTo,
    });
  }

  return mismatches.length > 0 ? { status: "mismatch", mismatches } : { status: "valid" };
}

/**
 * What to do when the check finds a problem.
 *
 * - `fail` (the default): throw a {@link FacilitatorCheckError} before the
 *   service starts serving. This is the default because the alternative is
 *   that the first paying agent discovers the misconfiguration, and an
 *   operator who runs the check at startup can fix it there.
 * - `warn`: pass the report to `onWarn` and resolve, so the service starts.
 *   Use it while a facilitator deploy is in progress, or when the service
 *   must start even if the facilitator is briefly down.
 * - `off`: skip the check without calling the facilitator.
 */
export type ValidationMode = "fail" | "warn" | "off";

/** The result of checking a set of routes against one facilitator. */
export type FacilitatorCheckReport =
  | {
      /** `ok` when no route has a mismatch. */
      status: "ok" | "mismatch";
      /** The result for every route, keyed by the label the caller gave it. */
      routes: Record<string, PaywallValidation>;
      /** Every mismatch across all routes. */
      mismatches: PaywallMismatch[];
    }
  | {
      /** `/supported` could not be read or did not parse. Nothing was checked. */
      status: "unavailable";
      reason: string;
    }
  | { status: "skipped" };

/**
 * Thrown in `fail` mode. `code` is `facilitator-unsupported` when a route
 * does not match the facilitator and `facilitator-unavailable` when
 * `/supported` could not be read. `report` carries the full result.
 */
export class FacilitatorCheckError extends TollwayError {
  readonly report: FacilitatorCheckReport;

  constructor(report: FacilitatorCheckReport, options?: { cause?: unknown }) {
    const unavailable = report.status === "unavailable";
    super(
      unavailable ? "facilitator-unavailable" : "facilitator-unsupported",
      unavailable
        ? `facilitator capabilities are unavailable: ${report.reason}`
        : `facilitator does not support every paywall: ${
            report.status === "mismatch" ? describeMismatches(report.mismatches) : report.status
          }`,
      options,
    );
    this.name = "FacilitatorCheckError";
    this.report = report;
  }
}

/** Checks paywalls against one facilitator, with `/supported` cached for a TTL. */
export type FacilitatorValidator = {
  /**
   * Checks every route. The keys are labels for the report, for example
   * `"GET /quotes"`. Throws in `fail` mode, calls `onWarn` in `warn` mode.
   */
  check(routes: Record<string, PaywallTarget>): Promise<FacilitatorCheckReport>;
  /** The cached capabilities, fetched when the cache is empty or stale. */
  getCapabilities(): Promise<FacilitatorCapabilities>;
  /** Drops the cache, so the next call reads `/supported` again. */
  refresh(): void;
};

export type FacilitatorValidatorOptions = {
  /** Defaults to `fail`; see {@link ValidationMode}. */
  mode?: ValidationMode;
  /**
   * How long a `/supported` response is reused, in milliseconds. Defaults to
   * one minute, so a facilitator deploy that drops a network shows up in the
   * next check after a minute without a restart.
   */
  ttlMs?: number;
  /**
   * In `warn` mode, called with the report when a route mismatches or the
   * facilitator is unavailable. Not called in `fail` or `off` mode.
   */
  onWarn?: (report: FacilitatorCheckReport) => void;
  /** Clock for the TTL cache. Defaults to `Date.now`. */
  clock?: () => number;
};

const DEFAULT_TTL_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a validator for one facilitator. Run `check` at startup, before
 * serving, and again whenever you want to notice a facilitator change.
 */
export function createFacilitatorValidator(
  facilitator: FacilitatorClient,
  options: FacilitatorValidatorOptions = {},
): FacilitatorValidator {
  const mode = options.mode ?? "fail";
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`ttlMs must be a positive finite number, got ${ttlMs}`);
  }
  const now = options.clock ?? Date.now;

  let cache: { capabilities: FacilitatorCapabilities; fetchedAt: number } | undefined;
  let inflight: Promise<FacilitatorCapabilities> | undefined;
  // Bumped by refresh(), so a request that started before it cannot fill
  // the cache with the old answer.
  let generation = 0;

  async function getCapabilities(): Promise<FacilitatorCapabilities> {
    if (cache && now() - cache.fetchedAt < ttlMs) {
      return cache.capabilities;
    }
    if (inflight) {
      // Concurrent callers share one request instead of each hitting /supported.
      return inflight;
    }
    const started = generation;
    const request = facilitator
      .supported()
      .then((capabilities) => {
        if (started === generation) {
          cache = { capabilities, fetchedAt: now() };
        }
        return capabilities;
      })
      .finally(() => {
        if (inflight === request) inflight = undefined;
      });
    inflight = request;
    return request;
  }

  async function check(routes: Record<string, PaywallTarget>): Promise<FacilitatorCheckReport> {
    if (mode === "off") {
      return { status: "skipped" };
    }

    let capabilities: FacilitatorCapabilities;
    try {
      capabilities = await getCapabilities();
    } catch (error) {
      // Unavailable is its own outcome: never a pass, and in fail mode the
      // service does not start, rather than treating the facilitator as
      // supporting everything.
      const report: FacilitatorCheckReport = { status: "unavailable", reason: errorMessage(error) };
      if (mode === "fail") {
        throw new FacilitatorCheckError(report, { cause: error });
      }
      options.onWarn?.(report);
      return report;
    }

    const results: Record<string, PaywallValidation> = {};
    const mismatches: PaywallMismatch[] = [];
    for (const [route, paywall] of Object.entries(routes)) {
      const result = validatePaywall(route, paywall, capabilities);
      results[route] = result;
      if (result.status === "mismatch") {
        mismatches.push(...result.mismatches);
      }
    }
    const report: FacilitatorCheckReport = {
      status: mismatches.length > 0 ? "mismatch" : "ok",
      routes: results,
      mismatches,
    };
    if (report.status === "mismatch") {
      if (mode === "fail") {
        throw new FacilitatorCheckError(report);
      }
      options.onWarn?.(report);
    }
    return report;
  }

  return {
    check,
    getCapabilities,
    refresh() {
      generation += 1;
      cache = undefined;
      inflight = undefined;
    },
  };
}

/** One line per mismatch, for logs and error messages. */
export function describeMismatches(mismatches: readonly PaywallMismatch[]): string {
  return mismatches
    .map(
      (mismatch) =>
        `route="${mismatch.route}" field=${mismatch.field} expected=${mismatch.expected} advertised=${mismatch.advertised}`,
    )
    .join("; ");
}
