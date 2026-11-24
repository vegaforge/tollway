/**
 * Multi-facilitator client with health checks and safe failover (Issue #156).
 *
 * A gate that talks to a single facilitator inherits its uptime: a transport
 * failure on `/verify` or `/settle` turns into a 5xx the payer sees. Fanning
 * out across several facilitators is naive-dangerous for settlement because
 * `@x402/stellar`'s facilitator picks its own transaction hash per `/settle`,
 * so two facilitators that both receive the same signed payment are not
 * idempotent at the network layer. Soroban's nonce prevents double on-chain
 * settlement, but the second facilitator reports an opaque rejection and the
 * payer who was in fact charged sees a failure.
 *
 * This module solves that by:
 *   - routing `/verify` and `/supported` freely across healthy facilitators;
 *   - pinning `/settle` to the first facilitator that received it, so a retry
 *     for the same payment always goes to the same facilitator (the pin lives
 *     in a seam next to the settlement cache);
 *   - classifying transport failures into pre-send (safe to retry elsewhere,
 *     the pin is released) and post-send (indeterminate, surfaced as
 *     `outcome-unknown`, pin stays, never retried on another facilitator);
 *   - tracking per-facilitator health with consecutive-failure counters and
 *     cool-downs, with half-open probes;
 *   - filtering facilitators by the capabilities they advertise, via the
 *     Issue #155 validator, before they are eligible for a given offer.
 *
 * Classifying a failure relies on the error's cause chain:
 * `createHttpFacilitator` keeps the network error as the cause of the
 * `TollwayError` it throws, and Node's fetch reports a refused connection or
 * a failed DNS lookup as a `cause.code`.
 *
 * Not solved here: resolving an `outcome-unknown` payment. The on-chain
 * nonce check is not implemented, and on a retry the gate verifies before
 * it settles, so a payment that did land can come back as a failed verify
 * rather than reaching the pinned facilitator again. Until that is built,
 * an `outcome-unknown` payment needs an operator or a later on-chain check
 * to confirm. Rendering `outcome-unknown` with `Retry-After` in the gate and
 * adapters is #161.
 */

import { TollwayError } from "@vegaforge/tollway-core";
import {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  SettleError,
  VerifyError,
} from "@x402/core/types";
import type { FacilitatorClient, SettleInput, VerifyInput } from "./facilitator.js";
import {
  type FacilitatorCapabilities,
  type FacilitatorValidator,
  findMatchingKind,
} from "./facilitator-capabilities.js";
import { isPreSendFailure } from "./transport-errors.js";

/**
 * Short-lived pin that ties a payment nonce to the facilitator that first
 * received its `/settle`. The async interface mirrors {@link SettlementCache}:
 * the in-memory implementation is enough for a single-process gate, and a
 * shared backend (Redis) plugs in by implementing this interface.
 */
export interface SettlementPinStore {
  get(key: string): Promise<string | undefined>;
  /**
   * Writes the pin only if none exists for this key (compare-and-set).
   * Returns the facilitator id now pinned to the key, which equals
   * `facilitatorId` when the caller won and otherwise the existing pin.
   */
  setIfAbsent(key: string, facilitatorId: string, ttlMs: number): Promise<string>;
  /**
   * Releases a pin only if it still belongs to `facilitatorId`, so the
   * caller cannot delete someone else's pin. Pre-send failover is the only
   * reason to call this: the pin was speculatively written, the first
   * request never left, and the entry is now wrong.
   */
  release(key: string, facilitatorId: string): Promise<boolean>;
}

const DEFAULT_PIN_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * One backing facilitator inside the failover. Each carries a stable id
 * (written to pins and events), the client Tollway talks to, and an optional
 * validator, usually `createFacilitatorValidator(client)`. With a validator,
 * the member is only eligible for an offer whose network its cached
 * `/supported` covers (Issue #155).
 */
export type FailoverMember = {
  id: string;
  client: FacilitatorClient;
  validator?: Pick<FacilitatorValidator, "getCapabilities">;
};

type Health = {
  consecutiveFailures: number;
  cooldownUntil: number;
  healthy: boolean;
};

/** Error categories; only `pre-send` is safe to retry on another facilitator. */
type ErrorKind = "structured" | "pre-send" | "outcome-unknown";

/** Observability hook. Emitted for every failover and every indeterminate outcome. */
export type FailoverEvent =
  | {
      type: "failover";
      operation: "verify" | "settle" | "supported";
      from: string;
      to: string;
      reason: string;
    }
  | { type: "outcome-unknown"; facilitator: string; operation: "settle"; reason: string }
  | { type: "health-changed"; facilitator: string; healthy: boolean }
  /** A member's `/supported` could not be read, so it was left out of this call. */
  | { type: "capabilities-unavailable"; facilitator: string; reason: string };

export type FailoverFacilitatorOptions = {
  /** Backing facilitators, in preferred order. At least one, unique ids. */
  facilitators: readonly FailoverMember[];
  /**
   * Pin store; defaults to an in-memory store sized for a single process.
   * A multi-process gate passes a shared-backend implementation.
   */
  pins?: SettlementPinStore;
  /** How long a pin lives. Longer than the longest reasonable settle retry window. */
  pinTtlMs?: number;
  health?: {
    /** Consecutive failures that flip a facilitator unhealthy. */
    failureThreshold?: number;
    /** How long an unhealthy facilitator stays out of rotation. */
    coolDownMs?: number;
  };
  clock?: () => number;
  onEvent?: (event: FailoverEvent) => void;
};

/**
 * In-memory {@link SettlementPinStore}. `setIfAbsent` is compare-and-set
 * under the stored TTL, so a second concurrent caller reads the existing
 * pin instead of overwriting it.
 */
export function createMemoryPinStore(clock: () => number = Date.now): SettlementPinStore {
  const pins = new Map<string, { facilitatorId: string; expiresAt: number }>();
  function current(key: string, now: number): string | undefined {
    const pin = pins.get(key);
    if (!pin) return undefined;
    if (pin.expiresAt <= now) {
      pins.delete(key);
      return undefined;
    }
    return pin.facilitatorId;
  }
  return {
    async get(key) {
      return current(key, clock());
    },
    async setIfAbsent(key, facilitatorId, ttlMs) {
      const now = clock();
      const existing = current(key, now);
      if (existing !== undefined) return existing;
      pins.set(key, { facilitatorId, expiresAt: now + ttlMs });
      return facilitatorId;
    },
    async release(key, facilitatorId) {
      const now = clock();
      const existing = current(key, now);
      if (existing !== facilitatorId) return false;
      pins.delete(key);
      return true;
    },
  };
}

/** Pin key: x402 model and the signed-payment nonce, same key the cache uses. */
function pinKey(payment: VerifyInput["payment"], nonce: string): string {
  return `${payment.model}:${nonce}`;
}

/**
 * Classifies an error thrown by a facilitator's `/settle`, `/verify` or
 * `/supported`. Only `pre-send` is safe to retry elsewhere. `structured`
 * means the facilitator rejected the payment deliberately; `outcome-unknown`
 * means we do not know whether the request was received.
 */
function classifyError(error: unknown): ErrorKind {
  if (error instanceof VerifyError || error instanceof SettleError) return "structured";
  if (error instanceof FacilitatorTimeoutError) return "outcome-unknown";
  if (error instanceof FacilitatorResponseError) return "outcome-unknown";
  if (isPreSendFailure(error)) return "pre-send";
  return "outcome-unknown";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The message of the innermost cause, the error the network layer raised. */
function rootMessage(error: unknown): string {
  let cursor = error;
  while (cursor instanceof Error && cursor.cause instanceof Error) {
    cursor = cursor.cause;
  }
  return describe(cursor);
}

/**
 * Multi-facilitator `FacilitatorClient`. `createHttpFacilitator` can be
 * swapped for this value without touching the gate: it implements the same
 * interface (idempotencyKey, verify, settle, supported) but routes each call
 * across the configured facilitators under the rules described at the top
 * of this file.
 */
export function createFailoverFacilitator(options: FailoverFacilitatorOptions): FacilitatorClient {
  if (options.facilitators.length === 0) {
    throw new TollwayError(
      "payment-failed",
      "createFailoverFacilitator: at least one facilitator must be provided",
    );
  }
  const seen = new Set<string>();
  for (const member of options.facilitators) {
    if (seen.has(member.id)) {
      throw new TollwayError(
        "payment-failed",
        `createFailoverFacilitator: duplicate facilitator id ${member.id}`,
      );
    }
    seen.add(member.id);
  }
  const clock = options.clock ?? Date.now;
  const pins = options.pins ?? createMemoryPinStore(clock);
  const pinTtlMs = options.pinTtlMs ?? DEFAULT_PIN_TTL_MS;
  const failureThreshold = options.health?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const coolDownMs = options.health?.coolDownMs ?? DEFAULT_COOLDOWN_MS;
  const emit = options.onEvent ?? (() => {});
  const health = new Map<string, Health>();
  for (const member of options.facilitators) {
    health.set(member.id, { consecutiveFailures: 0, cooldownUntil: 0, healthy: true });
  }

  function findMember(id: string): FailoverMember | undefined {
    return options.facilitators.find((m) => m.id === id);
  }

  /** True when this facilitator is in rotation right now (counting cool-down expiry). */
  function isUsable(id: string): boolean {
    const state = health.get(id);
    if (!state) return false;
    if (state.healthy) return true;
    if (state.cooldownUntil <= clock()) {
      // Half-open: a cool-down that has elapsed lets the next call through
      // as a probe. A success resets the counters; a failure trips it again.
      state.healthy = true;
      state.consecutiveFailures = 0;
      emit({ type: "health-changed", facilitator: id, healthy: true });
      return true;
    }
    return false;
  }

  function onSuccess(id: string): void {
    const state = health.get(id);
    if (!state) return;
    if (!state.healthy) {
      state.healthy = true;
      emit({ type: "health-changed", facilitator: id, healthy: true });
    }
    state.consecutiveFailures = 0;
  }

  function onFailure(id: string): void {
    const state = health.get(id);
    if (!state) return;
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= failureThreshold && state.healthy) {
      state.healthy = false;
      state.cooldownUntil = clock() + coolDownMs;
      emit({ type: "health-changed", facilitator: id, healthy: false });
    }
  }

  async function membersEligibleFor(
    offer: VerifyInput["offer"] | undefined,
  ): Promise<FailoverMember[]> {
    const usable = options.facilitators.filter((member) => isUsable(member.id));
    if (!offer) return usable;
    const eligible: FailoverMember[] = [];
    for (const member of usable) {
      if (!member.validator) {
        eligible.push(member);
        continue;
      }
      let capabilities: FacilitatorCapabilities;
      try {
        capabilities = await member.validator.getCapabilities();
      } catch (error) {
        // Unknown capabilities are not "supports everything": leave the
        // member out of this call and say why. Its health is judged by the
        // calls it actually answers.
        emit({
          type: "capabilities-unavailable",
          facilitator: member.id,
          reason: rootMessage(error),
        });
        continue;
      }
      if (findMatchingKind(capabilities, offer.network)) {
        eligible.push(member);
      }
    }
    return eligible;
  }

  /**
   * Walks eligible members in order and returns the first success. Failover
   * for `/verify` and `/supported` is always safe: neither has side effects.
   */
  async function firstSuccess<T>(
    operation: "verify" | "supported",
    offer: VerifyInput["offer"] | undefined,
    call: (member: FailoverMember) => Promise<T>,
  ): Promise<T> {
    const eligible = await membersEligibleFor(offer);
    if (eligible.length === 0) {
      throw new TollwayError(
        "payment-failed",
        `no facilitator eligible for ${operation}: all unhealthy or incompatible`,
      );
    }
    let lastError: unknown;
    for (let i = 0; i < eligible.length; i += 1) {
      const member = eligible[i];
      if (!member) continue;
      try {
        const value = await call(member);
        onSuccess(member.id);
        return value;
      } catch (error) {
        if (classifyError(error) === "structured") {
          // VerifyError: the facilitator rejected the payment on purpose.
          // Health stays; no other facilitator is tried.
          throw error;
        }
        lastError = error;
        onFailure(member.id);
        const next = eligible[i + 1];
        if (next) {
          emit({
            type: "failover",
            operation,
            from: member.id,
            to: next.id,
            reason: describe(error),
          });
        }
      }
    }
    throw new TollwayError(
      "payment-failed",
      `every eligible facilitator failed ${operation}: ${describe(lastError)}`,
    );
  }

  return {
    async idempotencyKey(input) {
      for (const member of options.facilitators) {
        if (member.client.idempotencyKey) {
          const key = await member.client.idempotencyKey(input);
          if (key !== undefined) return key;
        }
      }
      return undefined;
    },

    async verify(input) {
      return firstSuccess("verify", input.offer, (member) => member.client.verify(input));
    },

    async settle(input: SettleInput) {
      const key = pinKey(input.payment, input.nonce);
      const existingPin = await pins.get(key);
      if (existingPin !== undefined) {
        const pinned = findMember(existingPin);
        if (!pinned) {
          throw new TollwayError(
            "payment-failed",
            `pinned facilitator ${existingPin} is not configured in this failover set`,
          );
        }
        // Honour the pin even when the member is unhealthy: the payer is
        // already in flight with it and no other facilitator may be asked.
        return pinned.client.settle(input);
      }
      const eligible = await membersEligibleFor(input.offer);
      if (eligible.length === 0) {
        throw new TollwayError(
          "payment-failed",
          "no facilitator eligible for settle: all unhealthy or incompatible",
        );
      }
      let lastError: unknown;
      for (let i = 0; i < eligible.length; i += 1) {
        const member = eligible[i];
        if (!member) continue;
        const winnerId = await pins.setIfAbsent(key, member.id, pinTtlMs);
        if (winnerId !== member.id) {
          // Another process claimed the pin between our `get` and the
          // `setIfAbsent`. Hand the request to the winner, as if the pin
          // was there all along.
          const winner = findMember(winnerId);
          if (!winner) {
            throw new TollwayError(
              "payment-failed",
              `pin returned facilitator ${winnerId} which is not configured`,
            );
          }
          return winner.client.settle(input);
        }
        try {
          const result = await member.client.settle(input);
          onSuccess(member.id);
          return result;
        } catch (error) {
          const kind = classifyError(error);
          lastError = error;
          if (kind === "structured") {
            // SettleError: the facilitator rejected on purpose. Pin stays so
            // a retry of the same signed payment never reaches another
            // facilitator (Soroban nonce already spent after our verify
            // path, in the common case).
            throw error;
          }
          onFailure(member.id);
          if (kind === "pre-send") {
            // The request never left our side. Release the pin so the next
            // facilitator can own it, emit a failover event, and continue.
            await pins.release(key, member.id);
            const next = eligible[i + 1];
            if (next) {
              emit({
                type: "failover",
                operation: "settle",
                from: member.id,
                to: next.id,
                reason: describe(error),
              });
            }
            continue;
          }
          // outcome-unknown: pin stays, no retry elsewhere, surfaced with a
          // distinct code so the adapter answers with a Retry-After rather
          // than a plain settlement failure.
          emit({
            type: "outcome-unknown",
            facilitator: member.id,
            operation: "settle",
            reason: describe(error),
          });
          throw new TollwayError(
            "outcome-unknown",
            `settlement outcome unknown on ${member.id}: ${describe(error)}`,
          );
        }
      }
      throw new TollwayError(
        "payment-failed",
        `every eligible facilitator failed settle: ${describe(lastError)}`,
      );
    },

    async supported(): Promise<FacilitatorCapabilities> {
      return firstSuccess("supported", undefined, (member) => member.client.supported());
    },
  };
}
