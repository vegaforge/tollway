/**
 * A channel pool (#188): several payment channels per counterparty and asset,
 * each payment leases one of them, and the pool opens a replacement before a
 * channel runs dry.
 *
 * A commit on one channel is serialised (#175), so one channel handles one
 * payment at a time. The pool removes that bottleneck by leasing whichever
 * channel is free. Leases are in-process. Two processes sharing a store can
 * still race for one channel; the store's compare-and-set keeps its stream
 * correct, and the loser should lease another channel and retry.
 */

import { type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import type { Channel, ChannelManager } from "./types.js";

/** How the pool picks a free channel for a payment. */
export type PoolSelection = "least-drawn" | "round-robin";

export type ChannelPoolOptions = {
  /** Opens, reads and lists the channels. The pool never submits a commit itself. */
  manager: ChannelManager;
  network: StellarNetwork;
  /** Deposit for each channel the pool opens, as an integer string in base units. */
  deposit: string;
  /** Open a replacement once a channel's remaining deposit drops below this. */
  rotateBelow: string;
  /** The most channels the pool holds open for one counterparty and asset. */
  maxChannelsPerKey: number;
  /** The most deposit the pool may lock across every channel it holds. */
  maxLockedDeposit: string;
  /** Which free channel a payment gets. Defaults to `least-drawn`. */
  selection?: PoolSelection;
  /** How long `acquire` waits for a lease to come back before it rejects. Defaults to 5 s. */
  acquireTimeoutMs?: number;
  /** A lease not released within this time is reclaimed. Defaults to 60 s. */
  leaseTimeoutMs?: number;
  /** Told about every channel the pool drops or fails to open. */
  onFailure?: (failure: PoolFailure) => void;
};

/** A channel the pool could not use, and why. */
export type PoolFailure =
  | { kind: "open-failed"; counterparty: string; asset: string; error: unknown }
  | { kind: "channel-closed"; channelId: string; status: Channel["status"] | "missing" }
  /**
   * The channel's remaining deposit is below `rotateBelow` and a replacement
   * is open. The pool no longer leases it. The caller closes it (#180).
   */
  | { kind: "retired"; channelId: string; remaining: string };

export type PoolAcquireRequest = {
  counterparty: string;
  asset: string;
  /** The amount the payment will commit, as an integer string in base units. */
  amount: string;
};

/** A channel held for one payment. Give it back with `release`. */
export type ChannelLease = {
  readonly id: number;
  readonly channelId: string;
  /** When the lease is reclaimed if nobody releases it, as milliseconds since the epoch. */
  readonly expiresAt: number;
};

export type ChannelPool = {
  acquire(request: PoolAcquireRequest): Promise<ChannelLease>;
  release(lease: ChannelLease): Promise<void>;
};

/**
 * No channel can take the payment, and the pool cannot open one: every channel
 * is leased or too small, and the pool is at its channel or deposit limit.
 */
export class ChannelPoolExhaustedError extends TollwayError {
  readonly counterparty: string;
  readonly asset: string;

  constructor(counterparty: string, asset: string) {
    super(
      "channel-pool-exhausted",
      `no channel for ${counterparty} in ${asset} can take the payment before the pool times out`,
    );
    this.name = "ChannelPoolExhaustedError";
    this.counterparty = counterparty;
    this.asset = asset;
  }
}

const AMOUNT_RE = /^[0-9]+$/;

function units(value: string, field: string): bigint {
  if (!AMOUNT_RE.test(value)) {
    throw new TollwayError(
      "invalid-amount",
      `${field} "${value}" is not a valid non-negative integer string`,
    );
  }
  return BigInt(value);
}

type KeyState = {
  key: string;
  counterparty: string;
  asset: string;
  /** Open channels this pool holds for the key. */
  members: Set<string>;
  /** Channels currently leased. A channel is leased to at most one payment. */
  leasedIds: Set<string>;
  /** Resolves when the membership has been read from the store once. */
  loaded: Promise<void> | undefined;
  /** A replacement opening in the background. Never rejects. */
  opening: Promise<void> | undefined;
  /** Waiters parked until a lease comes back. */
  waiters: Array<() => void>;
  cursor: number;
};

type LeaseEntry = { channelId: string; state: KeyState; expiresAt: number };

type Snapshot = { id: string; committed: bigint; deposit: bigint; remaining: bigint };

export function createChannelPool(options: ChannelPoolOptions): ChannelPool {
  const {
    manager,
    network,
    selection = "least-drawn",
    acquireTimeoutMs = 5_000,
    leaseTimeoutMs = 60_000,
    onFailure,
  } = options;
  const depositUnits = units(options.deposit, "deposit");
  const rotateUnits = units(options.rotateBelow, "rotateBelow");
  const lockedCap = units(options.maxLockedDeposit, "maxLockedDeposit");
  const maxChannels = options.maxChannelsPerKey;
  if (!Number.isInteger(maxChannels) || maxChannels < 1) {
    throw new TollwayError(
      "invalid-policy",
      `maxChannelsPerKey must be a positive integer, got ${maxChannels}`,
    );
  }
  if (depositUnits === 0n) {
    throw new TollwayError("invalid-amount", "deposit must be greater than zero");
  }

  const states = new Map<string, KeyState>();
  /** The deposit of every channel the pool holds, so locked deposit is an exact sum. */
  const depositOf = new Map<string, bigint>();
  const leases = new Map<number, LeaseEntry>();
  /** Serialises acquires per key, so two of them never lease or open at once. */
  const chains = new Map<string, Promise<void>>();
  let leaseCount = 0;

  function report(failure: PoolFailure): void {
    onFailure?.(failure);
  }

  function stateFor(counterparty: string, asset: string): KeyState {
    const key = JSON.stringify([counterparty, asset]);
    let state = states.get(key);
    if (state === undefined) {
      state = {
        key,
        counterparty,
        asset,
        members: new Set(),
        leasedIds: new Set(),
        loaded: undefined,
        opening: undefined,
        waiters: [],
        cursor: 0,
      };
      states.set(key, state);
    }
    return state;
  }

  function serialise<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    // The tail never rejects, so one failed acquire does not block the queue.
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  function lockedTotal(): bigint {
    let total = 0n;
    for (const deposit of depositOf.values()) total += deposit;
    return total;
  }

  function addMember(state: KeyState, channel: Channel): void {
    state.members.add(channel.id);
    depositOf.set(channel.id, BigInt(channel.deposit));
  }

  function dropMember(state: KeyState, channelId: string): void {
    state.members.delete(channelId);
    depositOf.delete(channelId);
    wake(state);
  }

  /** Whether the pool may open one more channel for this key without passing a limit. */
  function canOpen(state: KeyState): boolean {
    return state.members.size < maxChannels && lockedTotal() + depositUnits <= lockedCap;
  }

  function wake(state: KeyState): void {
    const waiting = state.waiters;
    state.waiters = [];
    for (const resume of waiting) resume();
  }

  /** Reads the channels already open for this key, so a restart reuses them. */
  function load(state: KeyState): Promise<void> {
    if (state.loaded === undefined) {
      state.loaded = (async () => {
        let cursor: string | undefined;
        do {
          const page = await manager.listChannels({
            status: "open",
            counterparty: state.counterparty,
            asset: state.asset,
            network,
            limit: 200,
            cursor,
          });
          for (const channel of page.channels) addMember(state, channel);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      })().catch((error: unknown) => {
        state.loaded = undefined;
        throw error;
      });
    }
    return state.loaded;
  }

  /** Opens one channel and adds it to the pool. A failure is reported and rethrown. */
  async function openMember(state: KeyState): Promise<string> {
    try {
      const channel = await manager.open({
        counterparty: state.counterparty,
        asset: state.asset,
        deposit: options.deposit,
        network,
      });
      addMember(state, channel);
      return channel.id;
    } catch (error) {
      report({ kind: "open-failed", counterparty: state.counterparty, asset: state.asset, error });
      throw error;
    }
  }

  /** Opens the replacement in the background. Its failure is reported, never thrown. */
  function startReplacement(state: KeyState): void {
    const opening: Promise<void> = openMember(state).then(
      () => undefined,
      () => undefined,
    );
    state.opening = opening;
    opening.then(() => {
      if (state.opening === opening) state.opening = undefined;
      wake(state);
    });
  }

  function choose(candidates: Snapshot[], state: KeyState): string | undefined {
    if (candidates.length === 0) return undefined;
    if (selection === "round-robin") {
      const ordered = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const chosen = ordered[state.cursor % ordered.length];
      state.cursor += 1;
      return chosen?.id;
    }
    // Least drawn: the lowest committed share of its deposit, compared exactly.
    const ranked = [...candidates].sort((a, b) => {
      const left = a.committed * b.deposit;
      const right = b.committed * a.deposit;
      if (left !== right) return left < right ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return ranked[0]?.id;
  }

  /**
   * Reads every member, drops any the service reports closed, starts a
   * replacement for a channel running low, retires a low channel once a
   * healthy one exists, and returns the channel to lease for `amount`.
   */
  async function pickFree(state: KeyState, amount: bigint): Promise<string | undefined> {
    const snapshots: Snapshot[] = [];
    for (const id of [...state.members].sort()) {
      const channel = await manager.get(id);
      if (channel === undefined || channel.status !== "open") {
        dropMember(state, id);
        report({ kind: "channel-closed", channelId: id, status: channel?.status ?? "missing" });
        continue;
      }
      const committed = BigInt(channel.committed);
      const deposit = BigInt(channel.deposit);
      snapshots.push({ id, committed, deposit, remaining: deposit - committed });
    }

    const low = snapshots.filter((snapshot) => snapshot.remaining < rotateUnits);
    const healthy = snapshots.filter((snapshot) => snapshot.remaining >= rotateUnits);
    if (low.length > 0 && state.opening === undefined && canOpen(state)) {
      startReplacement(state);
    }
    if (healthy.length > 0) {
      for (const snapshot of low) {
        if (state.leasedIds.has(snapshot.id)) continue;
        dropMember(state, snapshot.id);
        report({
          kind: "retired",
          channelId: snapshot.id,
          remaining: snapshot.remaining.toString(),
        });
      }
    }

    // A low channel is not leased once its remaining deposit cannot cover the payment.
    const candidates = snapshots.filter(
      (snapshot) =>
        !state.leasedIds.has(snapshot.id) &&
        snapshot.remaining >= amount &&
        state.members.has(snapshot.id),
    );
    return choose(candidates, state);
  }

  function lease(state: KeyState, channelId: string): ChannelLease {
    leaseCount += 1;
    const expiresAt = Date.now() + leaseTimeoutMs;
    leases.set(leaseCount, { channelId, state, expiresAt });
    state.leasedIds.add(channelId);
    return { id: leaseCount, channelId, expiresAt };
  }

  /** Reclaims every lease whose holder never released it. */
  function reclaimExpired(now: number): void {
    for (const [id, entry] of leases) {
      if (entry.expiresAt > now) continue;
      leases.delete(id);
      entry.state.leasedIds.delete(entry.channelId);
      wake(entry.state);
    }
  }

  function waitForRelease(state: KeyState, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const resume = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        state.waiters = state.waiters.filter((waiter) => waiter !== resume);
        resolve();
      }, ms);
      state.waiters.push(resume);
    });
  }

  async function acquire(request: PoolAcquireRequest): Promise<ChannelLease> {
    const amount = units(request.amount, "amount");
    if (amount === 0n) {
      throw new TollwayError("invalid-amount", "a lease must cover an amount greater than zero");
    }
    const state = stateFor(request.counterparty, request.asset);
    return serialise(state.key, async () => {
      await load(state);
      const deadline = Date.now() + acquireTimeoutMs;
      for (;;) {
        reclaimExpired(Date.now());
        await state.opening;
        const picked = await pickFree(state, amount);
        if (picked !== undefined) return lease(state, picked);
        // A replacement is already opening: wait for it rather than open a second.
        if (state.opening !== undefined) {
          await state.opening;
          continue;
        }
        if (canOpen(state)) {
          const opened = await openMember(state);
          return lease(state, opened);
        }
        const wait = deadline - Date.now();
        if (wait <= 0) throw new ChannelPoolExhaustedError(state.counterparty, state.asset);
        await waitForRelease(state, wait);
      }
    });
  }

  async function release(lease: ChannelLease): Promise<void> {
    const entry = leases.get(lease.id);
    // Already released, or reclaimed after it expired: nothing is held, so nothing to do.
    if (entry === undefined) return;
    leases.delete(lease.id);
    entry.state.leasedIds.delete(entry.channelId);
    wake(entry.state);
  }

  return { acquire, release };
}
