import type { PaymentOffer, StellarNetwork } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";
import type { Network, SupportedKind } from "@x402/core/types";
import {
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "@x402/stellar";
import type { FacilitatorClient } from "./facilitator.js";

/**
 * The x402 scheme @x402/stellar implements; see `ExactStellarScheme.scheme`.
 * Duplicated from facilitator.ts rather than value-imported so this module
 * stays on the leaf side of the import graph.
 */
const STELLAR_EXACT_SCHEME = "exact";

/**
 * The full capability set an x402 facilitator advertises via `/supported`,
 * mapped one-for-one from the upstream `SupportedResponse` and schema-checked
 * at the boundary (pre-review checklist item 1). An asset list is deliberately
 * absent: x402 `/supported` does not advertise which tokens a facilitator will
 * accept — asset acceptance is only confirmed by the first `/verify`, which
 * is called out in docs/receipt-format.md.
 */
export type FacilitatorCapabilities = {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
};

/**
 * Parses a `/supported` response read from the wire. Every field is
 * narrowed with hand-rolled guards instead of a trusting cast so a
 * facilitator that answers with a lossy or malformed payload is caught
 * at the gate rather than at the first paying request.
 *
 * Throws `TollwayError("payment-failed", ...)` with a message that names
 * the offending field, mirroring the error class the HTTP client already
 * uses for every other facilitator-side failure.
 */
export function parseFacilitatorCapabilities(raw: unknown): FacilitatorCapabilities {
  if (!raw || typeof raw !== "object") {
    throw new TollwayError("payment-failed", "facilitator /supported response is not an object");
  }
  const body = raw as Record<string, unknown>;

  if (!Array.isArray(body.kinds)) {
    throw new TollwayError(
      "payment-failed",
      "facilitator /supported response has no `kinds` array",
    );
  }

  const kinds: SupportedKind[] = body.kinds.map((rawKind, index) => {
    if (!rawKind || typeof rawKind !== "object" || Array.isArray(rawKind)) {
      throw new TollwayError(
        "payment-failed",
        `facilitator /supported kinds[${index}] is not an object`,
      );
    }
    const kind = rawKind as Record<string, unknown>;
    if (typeof kind.x402Version !== "number" || !Number.isFinite(kind.x402Version)) {
      throw new TollwayError(
        "payment-failed",
        `facilitator /supported kinds[${index}].x402Version is not a number`,
      );
    }
    if (typeof kind.scheme !== "string" || kind.scheme.length === 0) {
      throw new TollwayError(
        "payment-failed",
        `facilitator /supported kinds[${index}].scheme is not a non-empty string`,
      );
    }
    if (typeof kind.network !== "string" || kind.network.length === 0) {
      throw new TollwayError(
        "payment-failed",
        `facilitator /supported kinds[${index}].network is not a non-empty string`,
      );
    }
    if (
      kind.extra !== undefined &&
      (typeof kind.extra !== "object" || kind.extra === null || Array.isArray(kind.extra))
    ) {
      throw new TollwayError(
        "payment-failed",
        `facilitator /supported kinds[${index}].extra is not an object`,
      );
    }
    const result: SupportedKind = {
      x402Version: kind.x402Version,
      scheme: kind.scheme,
      network: kind.network as Network,
    };
    if (kind.extra !== undefined) {
      result.extra = kind.extra as Record<string, unknown>;
    }
    return result;
  });

  const extensions: string[] = Array.isArray(body.extensions)
    ? body.extensions.filter((value): value is string => typeof value === "string")
    : [];
  if (body.extensions !== undefined && !Array.isArray(body.extensions)) {
    throw new TollwayError(
      "payment-failed",
      "facilitator /supported response has a non-array `extensions` field",
    );
  }

  let signers: Record<string, string[]> = {};
  if (body.signers !== undefined) {
    if (!body.signers || typeof body.signers !== "object" || Array.isArray(body.signers)) {
      throw new TollwayError(
        "payment-failed",
        "facilitator /supported response has a non-object `signers` field",
      );
    }
    signers = Object.fromEntries(
      Object.entries(body.signers).map(([network, rawList]) => {
        if (!Array.isArray(rawList)) {
          throw new TollwayError(
            "payment-failed",
            `facilitator /supported signers[${network}] is not an array`,
          );
        }
        return [network, rawList.filter((value): value is string => typeof value === "string")];
      }),
    );
  }

  return { kinds, extensions, signers };
}

/**
 * The paywall-validation stance operators pick at gate construction.
 *
 * - `fail` (default): raise a typed error before serving any request if
 *   the facilitator does not advertise support for the paywall. Fail-fast
 *   is the safe default because the alternative is the first paying agent
 *   being the one who discovers the misconfiguration.
 * - `warn`: report every mismatch through the caller's `onWarn` and keep
 *   serving. Useful when the facilitator is under active deployment and
 *   the operator wants to catch the window where `/supported` is stale.
 * - `off`: skip the check entirely. The historic pre-Issue-#155 behaviour;
 *   the gate relies on the first `/verify` to catch misconfiguration.
 */
export type ValidationMode = "fail" | "warn" | "off";

/**
 * One capability mismatch between a paywall and what the facilitator
 * advertises. The field / expected / advertised triple is enough for an
 * operator to see which paywall is wrong without tailing the full
 * `/supported` body.
 */
export type PaywallMismatch = {
  route: string;
  field: "x402Version" | "scheme" | "network" | "extra.areFeesSponsored" | "asset" | "payTo";
  expected: string;
  advertised: string;
};

export type ValidationResult = { valid: true } | { valid: false; mismatches: PaywallMismatch[] };

const NETWORK_CAIP2: Record<StellarNetwork, Network> = {
  testnet: STELLAR_TESTNET_CAIP2,
  mainnet: STELLAR_PUBNET_CAIP2,
};

/**
 * x402 Stellar supports a wildcard network ("stellar:*") so a facilitator
 * that advertises both networks in one kind matches any paywall network.
 */
const STELLAR_WILDCARD_CAIP2 = "stellar:*";

/**
 * The x402 wire version Tollway speaks on the server (ADR-2026-11-17).
 * A facilitator that only advertises v1 cannot settle for this gate.
 */
const EXPECTED_X402_VERSION = 2;

/**
 * Compares a paywall offer against a facilitator's advertised capabilities
 * and returns every mismatch. The caller decides whether to throw, warn
 * or ignore (see {@link ValidationMode}).
 *
 * The check covers everything x402 `/supported` can answer:
 * - x402 wire version 2 is offered
 * - `exact` scheme is offered for the paywall's CAIP-2 network, or for
 *   the `stellar:*` wildcard network
 * - the offer's `extra.areFeesSponsored` (when set) agrees with the
 *   matching kind's `extra.areFeesSponsored`
 * - `asset` is a Stellar C-account contract address (not the `CODE:ISSUER`
 *   form the mock demo uses) and `payTo` is a valid destination.
 *
 * Asset-acceptance is not advertised by `/supported`, so a facilitator that
 * only accepts one specific token slips past this check and is caught at
 * the first `/verify`. Documented in docs/receipt-format.md.
 */
export function validatePaywall(
  offer: PaymentOffer,
  capabilities: FacilitatorCapabilities,
  options: { expectedFeesSponsored?: boolean } = {},
): ValidationResult {
  const mismatches: PaywallMismatch[] = [];
  const expectedNetwork = NETWORK_CAIP2[offer.network];
  const route = offer.resource;

  const versionMatches = capabilities.kinds.some(
    (kind) => kind.x402Version === EXPECTED_X402_VERSION,
  );
  if (!versionMatches) {
    const advertisedVersions = Array.from(
      new Set(capabilities.kinds.map((kind) => String(kind.x402Version))),
    ).join(",");
    mismatches.push({
      route,
      field: "x402Version",
      expected: String(EXPECTED_X402_VERSION),
      advertised: advertisedVersions || "none",
    });
  }

  const schemeMatches = capabilities.kinds.some(
    (kind) => kind.x402Version === EXPECTED_X402_VERSION && kind.scheme === STELLAR_EXACT_SCHEME,
  );
  if (!schemeMatches) {
    const advertisedSchemes = Array.from(
      new Set(
        capabilities.kinds
          .filter((kind) => kind.x402Version === EXPECTED_X402_VERSION)
          .map((kind) => kind.scheme),
      ),
    ).join(",");
    mismatches.push({
      route,
      field: "scheme",
      expected: STELLAR_EXACT_SCHEME,
      advertised: advertisedSchemes || "none",
    });
  }

  const matchingKind = capabilities.kinds.find(
    (kind) =>
      kind.x402Version === EXPECTED_X402_VERSION &&
      kind.scheme === STELLAR_EXACT_SCHEME &&
      (kind.network === expectedNetwork || kind.network === STELLAR_WILDCARD_CAIP2),
  );
  if (!matchingKind) {
    const advertisedNetworks = Array.from(
      new Set(
        capabilities.kinds
          .filter(
            (kind) =>
              kind.x402Version === EXPECTED_X402_VERSION && kind.scheme === STELLAR_EXACT_SCHEME,
          )
          .map((kind) => kind.network),
      ),
    ).join(",");
    mismatches.push({
      route,
      field: "network",
      expected: `${expectedNetwork} or ${STELLAR_WILDCARD_CAIP2}`,
      advertised: advertisedNetworks || "none",
    });
  }

  if (matchingKind && options.expectedFeesSponsored !== undefined) {
    const advertisedFees = matchingKind.extra?.areFeesSponsored;
    if (typeof advertisedFees !== "boolean" || advertisedFees !== options.expectedFeesSponsored) {
      mismatches.push({
        route,
        field: "extra.areFeesSponsored",
        expected: String(options.expectedFeesSponsored),
        advertised: advertisedFees === undefined ? "unset" : String(advertisedFees),
      });
    }
  }

  if (!validateStellarAssetAddress(offer.asset)) {
    mismatches.push({
      route,
      field: "asset",
      expected: "Stellar contract address (C...)",
      advertised: offer.asset,
    });
  }

  if (!validateStellarDestinationAddress(offer.payTo)) {
    mismatches.push({
      route,
      field: "payTo",
      expected: "Stellar destination (G... / M... / C...)",
      advertised: offer.payTo,
    });
  }

  return mismatches.length > 0 ? { valid: false, mismatches } : { valid: true };
}

/**
 * A capability-validated view of one facilitator. `validate` is called once
 * per paywall at startup (fail mode) and can be called again from an
 * operator-driven refresh path (`refresh()`) to pick up a deploy that drops
 * a network without restarting the server.
 */
export type FacilitatorValidator = {
  validate(
    offer: PaymentOffer,
    options?: { expectedFeesSponsored?: boolean },
  ): Promise<ValidationResult>;
  getCapabilities(): Promise<FacilitatorCapabilities>;
  refresh(): Promise<void>;
};

export type FacilitatorValidatorOptions = {
  mode: ValidationMode;
  /**
   * How long a cached `/supported` response is reused. Defaults to one
   * minute so a facilitator deploy that drops a network is noticed within
   * a minute, not at next process restart.
   */
  ttlMs?: number;
  /**
   * Called once per `validate()` call that lands with mismatches when
   * `mode === "warn"`. Not called in `fail` (the error is thrown instead)
   * or `off` (the check is skipped). Must not throw.
   */
  onWarn?: (mismatches: PaywallMismatch[]) => void;
  /** Injectable clock for the TTL cache. Defaults to Date.now. */
  clock?: () => number;
};

const DEFAULT_TTL_MS = 60_000;

export function createFacilitatorValidator(
  facilitator: FacilitatorClient,
  options: FacilitatorValidatorOptions,
): FacilitatorValidator {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.clock ?? (() => Date.now());

  let cache: { capabilities: FacilitatorCapabilities; fetchedAt: number } | null = null;
  let inflight: Promise<FacilitatorCapabilities> | null = null;

  async function getCapabilities(): Promise<FacilitatorCapabilities> {
    if (cache && now() - cache.fetchedAt < ttlMs) {
      return cache.capabilities;
    }
    if (inflight) {
      return inflight;
    }
    inflight = (async () => {
      const capabilities = await facilitator.supported();
      cache = { capabilities, fetchedAt: now() };
      return capabilities;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  return {
    async validate(offer, perCallOptions = {}) {
      if (options.mode === "off") {
        return { valid: true };
      }

      let capabilities: FacilitatorCapabilities;
      try {
        capabilities = await getCapabilities();
      } catch (error) {
        // A facilitator that is down at startup must not crash a `warn`
        // service and must not be silently treated as "supports everything"
        // in `fail`. Fail mode propagates the error so the operator sees
        // it immediately; warn mode reports a synthetic mismatch so the
        // observability callback fires, then returns valid so the gate
        // keeps serving.
        if (options.mode === "fail") {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        options.onWarn?.([
          {
            route: offer.resource,
            field: "network",
            expected: "any",
            advertised: `facilitator unreachable: ${message}`,
          },
        ]);
        return { valid: true };
      }

      const result = validatePaywall(offer, capabilities, perCallOptions);
      if (!result.valid && options.mode === "warn") {
        options.onWarn?.(result.mismatches);
      }
      return result;
    },
    async getCapabilities() {
      return getCapabilities();
    },
    async refresh() {
      cache = null;
      await getCapabilities();
    },
  };
}

/**
 * Builds a human-readable summary of a mismatch list. Used by `fail` mode
 * when it throws and by the demo when it prints the result at startup.
 */
export function describeMismatches(mismatches: PaywallMismatch[]): string {
  return mismatches
    .map(
      (mismatch) =>
        `route="${mismatch.route}" field=${mismatch.field} expected=${mismatch.expected} advertised=${mismatch.advertised}`,
    )
    .join("; ");
}

/**
 * Throws a `TollwayError("payment-failed", ...)` with every mismatch
 * enumerated in the message. The caller in `fail` mode can turn this
 * into a server-boot abort.
 */
export function assertPaywallValid(
  offer: PaymentOffer,
  capabilities: FacilitatorCapabilities,
  options: { expectedFeesSponsored?: boolean } = {},
): void {
  const result = validatePaywall(offer, capabilities, options);
  if (!result.valid) {
    throw new TollwayError(
      "payment-failed",
      `facilitator does not advertise support for this paywall: ${describeMismatches(result.mismatches)}`,
    );
  }
}
