import type { PaymentOffer, SettlementModel } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";

/**
 * The stable reason codes a service policy denial carries. They are part of
 * the gate's rejection outcome, so callers can branch on them instead of
 * parsing a message.
 */
export const SERVICE_POLICY_DENIALS = {
  /** The payer is not on an allowlist, or is on a denylist. */
  notAllowed: "service-policy:not-allowed",
  /** The payer made too many requests in the current window. */
  rateLimited: "service-policy:rate-limited",
  /** The payer would exceed its spend cap in the current window. */
  spendExceeded: "service-policy:spend-exceeded",
} as const;

/** A stable reason code from {@link SERVICE_POLICY_DENIALS}. */
export type ServicePolicyDenialCode =
  (typeof SERVICE_POLICY_DENIALS)[keyof typeof SERVICE_POLICY_DENIALS];

/**
 * Rules a service operator applies to the payers of one or more routes,
 * evaluated after the payment is verified and before it is settled. This is
 * the service's policy, not the agent's own budget (core's `Policy`): the
 * agent decides what it is willing to spend, the service decides whom it
 * serves and how much.
 *
 * All windows are fixed, UTC-millisecond windows aligned to the epoch, and
 * default to 60 seconds. Amounts are integer strings in the asset's smallest
 * unit and are tracked per asset.
 */
export type ServicePolicy = {
  /**
   * When set, only these payer addresses are served. An empty list serves
   * nobody. A payer missing from the list and a payer on the denylist get the
   * same denial, so the answer does not reveal which list matched.
   */
  allowPayers?: readonly string[];
  /**
   * Payer addresses that are never served. A denial for a denylisted payer is
   * indistinguishable from a denial for a payer missing from `allowPayers`.
   */
  denyPayers?: readonly string[];
  /** Requests allowed per payer in one window. */
  requestsPerWindow?: {
    /** Maximum requests in the window. */
    limit: number;
    /** Window length in seconds. Defaults to 60. */
    windowSeconds?: number;
  };
  /**
   * Spend allowed per payer, per asset, in one window. The offer's asset
   * selects the counter.
   */
  spendPerWindow?: {
    /** Maximum spend as an integer string in the asset's smallest unit. */
    limit: string;
    /** Window length in seconds. Defaults to 60. */
    windowSeconds?: number;
  };
};

/**
 * A reservation taken when a request is admitted. It holds the request and
 * spend slots until the gate commits the settled payment or releases it on a
 * failure. A shared store uses the same type, so the gate never needs to know
 * how the store keeps its state.
 */
export type ServicePolicyReservation = {
  /** The verified payer the reservation belongs to. */
  readonly payer: string;
  /** The offer's asset, used for the spend counter. */
  readonly asset: string;
  /** The offer's amount in the asset's smallest unit. */
  readonly amount: bigint;
  /** Start of the request window this reservation holds a slot in. */
  readonly requestWindowStart?: number;
  /** Start of the spend window this reservation holds an amount in. */
  readonly spendWindowStart?: number;
};

/** What a service policy store decided for one request. */
export type ServicePolicyDecision =
  | { allowed: true; reservation?: ServicePolicyReservation }
  | {
      allowed: false;
      code: ServicePolicyDenialCode;
      /** How long until the window rolls over, when a window caused it. */
      retryAfterMs?: number;
    };

/** The input one policy evaluation sees. */
export type ServicePolicyInput = {
  policy: ServicePolicy;
  /** Payer address returned by the facilitator's verify. */
  payer: string;
  offer: PaymentOffer;
  model: SettlementModel;
  /** Milliseconds since the epoch, from the gate's injected clock. */
  now: number;
};

/**
 * Per-payer state behind the service policy. The gate calls `admit` after
 * `/verify` and before the settlement lock, then `commit` once the payment
 * settles or `release` when it does not. `admit` must decide and reserve in
 * one step: two concurrent requests from one payer must not both pass a cap
 * only one of them fits under.
 *
 * The in-memory implementation from {@link createInMemoryServicePolicyStore}
 * is the default. In a multi-process deployment each process has its own
 * state, so a shared implementation is needed for limits to hold across
 * processes; see #190.
 */
export interface ServicePolicyStore {
  /** Checks the policy and reserves the request's slots if it is allowed. */
  admit(input: ServicePolicyInput): Promise<ServicePolicyDecision>;
  /** Turns a reservation into recorded request and spend usage. */
  commit(reservation: ServicePolicyReservation): Promise<void>;
  /** Drops a reservation when the payment did not settle. */
  release(reservation: ServicePolicyReservation): Promise<void>;
}

export type InMemoryServicePolicyStoreOptions = {
  /**
   * Most payer entries held at once. The least recently used payer is
   * evicted when a new payer would exceed it. Defaults to 10 000.
   */
  maxPayers?: number;
};

const DEFAULT_MAX_PAYERS = 10_000;
const DEFAULT_WINDOW_SECONDS = 60;

type NormalizedPolicy = {
  allow?: ReadonlySet<string>;
  deny?: ReadonlySet<string>;
  requests?: { limit: number; windowMs: number };
  spend?: { limit: bigint; windowMs: number };
};

type RequestWindow = { start: number; used: number; pending: number };
type SpendWindow = { start: number; used: bigint; pending: bigint };
type PayerState = {
  requests: RequestWindow;
  spend: Map<string, SpendWindow>;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TollwayError("invalid-policy", `${label} must be a positive integer`);
  }
  return value;
}

function windowMs(windowSeconds: number | undefined, label: string): number {
  return positiveInteger(windowSeconds ?? DEFAULT_WINDOW_SECONDS, label) * 1000;
}

function payerList(value: readonly string[] | undefined, label: string): Set<string> | undefined {
  if (value === undefined) return undefined;
  const payers = new Set<string>();
  for (const payer of value) {
    if (typeof payer !== "string" || payer.length === 0) {
      throw new TollwayError("invalid-policy", `${label} must contain non-empty payer addresses`);
    }
    payers.add(payer);
  }
  return payers;
}

function normalizePolicy(policy: ServicePolicy): NormalizedPolicy {
  const normalized: NormalizedPolicy = {
    allow: payerList(policy.allowPayers, "allowPayers"),
    deny: payerList(policy.denyPayers, "denyPayers"),
  };
  if (policy.requestsPerWindow) {
    normalized.requests = {
      limit: positiveInteger(policy.requestsPerWindow.limit, "requestsPerWindow.limit"),
      windowMs: windowMs(policy.requestsPerWindow.windowSeconds, "requestsPerWindow.windowSeconds"),
    };
  }
  if (policy.spendPerWindow) {
    const amount = policy.spendPerWindow.limit;
    if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
      throw new TollwayError(
        "invalid-policy",
        "spendPerWindow.limit must be a non-negative integer string",
      );
    }
    normalized.spend = {
      limit: BigInt(amount),
      windowMs: windowMs(policy.spendPerWindow.windowSeconds, "spendPerWindow.windowSeconds"),
    };
  }
  return normalized;
}

/**
 * Checks a service policy once at construction, so a bad limit fails startup
 * instead of the first paid request.
 */
export function validateServicePolicy(policy: ServicePolicy): void {
  normalizePolicy(policy);
}

function windowStart(now: number, size: number): number {
  return Math.floor(now / size) * size;
}

function retryAfterMs(now: number, start: number, size: number): number {
  return Math.max(1, start + size - now);
}

/**
 * The default in-memory service policy store. It keeps one entry per payer
 * and evicts the least recently used entry when `maxPayers` is reached, so
 * an attacker rotating payer addresses cannot grow memory without bound. The
 * bound is per store: one gate (or route table) that shares a store shares
 * the bound.
 *
 * Admissions are synchronous inside `admit`, and the gate calls it before
 * taking the settlement lock, so two requests from one payer cannot both
 * pass a cap only one fits under within this process. Processes do not share
 * this state; inject a shared `ServicePolicyStore` for that (#190).
 */
export function createInMemoryServicePolicyStore(
  options: InMemoryServicePolicyStoreOptions = {},
): ServicePolicyStore {
  const maxPayers = positiveInteger(options.maxPayers ?? DEFAULT_MAX_PAYERS, "maxPayers");
  const payers = new Map<string, PayerState>();

  function moveToEnd(payer: string, state: PayerState): void {
    payers.delete(payer);
    payers.set(payer, state);
  }

  function payerState(payer: string): PayerState {
    const existing = payers.get(payer);
    if (existing) {
      moveToEnd(payer, existing);
      return existing;
    }
    while (payers.size >= maxPayers) {
      const oldest = payers.keys().next();
      if (oldest.done) break;
      payers.delete(oldest.value);
    }
    const created: PayerState = {
      requests: { start: 0, used: 0, pending: 0 },
      spend: new Map(),
    };
    payers.set(payer, created);
    return created;
  }

  function spendWindow(state: PayerState, asset: string, now: number, size: number): SpendWindow {
    const start = windowStart(now, size);
    const current = state.spend.get(asset);
    if (current && current.start === start) return current;
    const next: SpendWindow = { start, used: 0n, pending: 0n };
    state.spend.set(asset, next);
    return next;
  }

  return {
    async admit(input) {
      const policy = normalizePolicy(input.policy);
      const { payer, offer, now } = input;

      // Both lists answer the same way: the deny decision never says which
      // list matched, so a denial does not disclose operator configuration.
      if (policy.deny?.has(payer) || (policy.allow && !policy.allow.has(payer))) {
        return { allowed: false, code: SERVICE_POLICY_DENIALS.notAllowed };
      }

      if (!policy.requests && !policy.spend) {
        return { allowed: true };
      }

      const amount = BigInt(offer.amount);
      const state = payerState(payer);
      let requestStart: number | undefined;
      let spendStart: number | undefined;

      if (policy.requests) {
        const start = windowStart(now, policy.requests.windowMs);
        if (state.requests.start !== start) {
          state.requests = { start, used: 0, pending: 0 };
        }
        requestStart = start;
        if (state.requests.used + state.requests.pending + 1 > policy.requests.limit) {
          return {
            allowed: false,
            code: SERVICE_POLICY_DENIALS.rateLimited,
            retryAfterMs: retryAfterMs(now, start, policy.requests.windowMs),
          };
        }
      }

      if (policy.spend) {
        const window = spendWindow(state, offer.asset, now, policy.spend.windowMs);
        spendStart = window.start;
        if (window.used + window.pending + amount > policy.spend.limit) {
          return {
            allowed: false,
            code: SERVICE_POLICY_DENIALS.spendExceeded,
            retryAfterMs: retryAfterMs(now, window.start, policy.spend.windowMs),
          };
        }
      }

      if (policy.requests && requestStart !== undefined) {
        state.requests.pending += 1;
      }
      if (policy.spend && spendStart !== undefined) {
        const window = spendWindow(state, offer.asset, now, policy.spend.windowMs);
        window.pending += amount;
      }

      const reservation: ServicePolicyReservation = {
        payer,
        asset: offer.asset,
        amount,
        ...(requestStart === undefined ? {} : { requestWindowStart: requestStart }),
        ...(spendStart === undefined ? {} : { spendWindowStart: spendStart }),
      };
      return { allowed: true, reservation };
    },

    async commit(reservation) {
      const state = payers.get(reservation.payer);
      if (!state) return;
      moveToEnd(reservation.payer, state);

      if (
        reservation.requestWindowStart !== undefined &&
        state.requests.start === reservation.requestWindowStart
      ) {
        if (state.requests.pending > 0) state.requests.pending -= 1;
        state.requests.used += 1;
      }

      const window = state.spend.get(reservation.asset);
      if (
        window &&
        reservation.spendWindowStart !== undefined &&
        window.start === reservation.spendWindowStart &&
        window.pending >= reservation.amount
      ) {
        window.pending -= reservation.amount;
        window.used += reservation.amount;
      }
    },

    async release(reservation) {
      const state = payers.get(reservation.payer);
      if (!state) return;
      moveToEnd(reservation.payer, state);

      if (
        reservation.requestWindowStart !== undefined &&
        state.requests.start === reservation.requestWindowStart &&
        state.requests.pending > 0
      ) {
        state.requests.pending -= 1;
      }

      const window = state.spend.get(reservation.asset);
      if (
        window &&
        reservation.spendWindowStart !== undefined &&
        window.start === reservation.spendWindowStart &&
        window.pending >= reservation.amount
      ) {
        window.pending -= reservation.amount;
      }
    },
  };
}
