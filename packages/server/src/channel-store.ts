import { stellarNetworks, TollwayError } from "@vegaforge/tollway-core";
import { z } from "zod";

/**
 * What the service knows about each one-way channel it receives payments on:
 * the on-chain facts read when the channel was registered, the latest voucher
 * it accepted, and where the channel is in its life (open, settling, closed).
 *
 * The gate (#173) writes vouchers here and the settlement module (#174) closes
 * channels from it. Both sides change a record only through
 * {@link ChannelStore.compareAndSet}, so two processes sharing a store cannot
 * both accept a voucher at the same sequence or both close one channel.
 */

/**
 * `open` accepts vouchers. `settling` is frozen while a close is attempted or
 * its outcome is unknown; it never accepts vouchers again. `closed` is final.
 */
export const channelStatuses = ["open", "settling", "closed"] as const;

/** Where a channel is in its life; see {@link channelStatuses}. */
export type ChannelStatus = (typeof channelStatuses)[number];

const integerString = z.string().regex(/^[0-9]+$/, "expected an integer string");
const hexSignature = z.string().regex(/^[0-9a-fA-F]{128}$/, "expected 128 hex characters");
const epochMs = z.number().int().nonnegative();

const acceptedVoucherFields = {
  /** 1 for the first voucher accepted on the channel, then +1 per voucher. */
  sequence: z.number().int().positive(),
  /** Total the funder has committed, in base units. Cumulative, not a delta. */
  cumulativeAmount: integerString,
  /** The funder's Ed25519 signature over the channel's commitment bytes. */
  signature: hexSignature,
  acceptedAt: epochMs,
};

/** A voucher the service accepted, in the order it accepted them. */
export const acceptedVoucherSchema = z.strictObject(acceptedVoucherFields);

/** A voucher the service accepted; see {@link acceptedVoucherSchema}. */
export type AcceptedVoucher = z.infer<typeof acceptedVoucherSchema>;

/**
 * The `SettlementRecord` `@vegaforge/tollway-reconcile` consumes. The server
 * cannot import that package (see the layering table in AGENTS.md), so the
 * shape is repeated here and kept identical.
 */
export const channelSettlementRecordSchema = z.strictObject({
  channelId: z.string().min(1),
  settledAmount: integerString,
  returnedRemainder: integerString,
  txHash: z.string().min(1),
});

/** One closed channel's outcome, for reconciliation. */
export type ChannelSettlementRecord = z.infer<typeof channelSettlementRecordSchema>;

/** A channel's stored state. Values read back from a store are parsed with it. */
export const channelRecordSchema = z.strictObject({
  channelId: z.string().min(1),
  network: z.enum(stellarNetworks),
  /** The funder (`from` on chain). Receipts name it as the payer. */
  payer: z.string().min(1),
  /** The channel's recipient (`to` on chain); equals the offer's `payTo`. */
  payTo: z.string().min(1),
  /** The token contract the channel pays in; equals the offer's asset. */
  asset: z.string().min(1),
  /** The funder's commitment public key (`G...`), read from the contract. */
  commitmentKey: z.string().min(1),
  refundWaitingPeriod: z.number().int().nonnegative(),
  registeredAt: epochMs,
  status: z.enum(channelStatuses),
  /**
   * Bumped by one on every write. {@link ChannelStore.compareAndSet} writes
   * only when the stored version is the one the writer read.
   */
  version: z.number().int().positive(),
  latest: acceptedVoucherSchema.optional(),
  /**
   * A voucher handed to `@stellar/mpp` whose outcome is not recorded yet.
   * While it is set no other voucher is accepted; a crash leaves it behind
   * for {@link MppChannelHandler.reconcile} to resolve.
   */
  pending: z
    .strictObject({ ...acceptedVoucherFields, action: z.enum(["voucher", "close"]) })
    .optional(),
  /** Present once a close has been started. */
  settlement: z
    .strictObject({
      startedAt: epochMs,
      /** How the close was started: by the settlement module, or by the agent's close credential. */
      trigger: z.enum(["service", "agent"]),
      /** On-chain balance read just before the close was sent. */
      balanceBefore: integerString.optional(),
      /** True when the chain shows the close did not land, so it may be sent again. */
      retryable: z.boolean(),
      lastError: z.string().optional(),
      record: channelSettlementRecordSchema.optional(),
      closedAt: epochMs.optional(),
    })
    .optional(),
});

/** A channel's stored state; see {@link channelRecordSchema}. */
export type ChannelRecord = z.infer<typeof channelRecordSchema>;

/**
 * Durable channel state. The gate and the settlement module never read a
 * value and write it back in two steps: every change is a compare-and-set on
 * `version`.
 *
 * {@link createInMemoryChannelStore} is correct in one process. Several
 * processes need a shared backend whose `compareAndSet` is linearizable, such
 * as a Redis Lua script or a PostgreSQL `UPDATE ... WHERE version = $n`.
 */
export interface ChannelStore {
  get(channelId: string): Promise<ChannelRecord | undefined>;
  /**
   * Writes `next` only if the stored record's version is `expectedVersion`
   * (0 when no record exists yet) and `next.version` is `expectedVersion + 1`.
   * Resolves false, and changes nothing, otherwise.
   */
  compareAndSet(channelId: string, expectedVersion: number, next: ChannelRecord): Promise<boolean>;
  list(): Promise<readonly ChannelRecord[]>;
}

/** An in-process {@link ChannelStore}. Records are copied in and out, so callers cannot alias them. */
export function createInMemoryChannelStore(): ChannelStore {
  const records = new Map<string, ChannelRecord>();
  return {
    async get(channelId) {
      const record = records.get(channelId);
      return record ? structuredClone(record) : undefined;
    },
    async compareAndSet(channelId, expectedVersion, next) {
      if (next.channelId !== channelId || next.version !== expectedVersion + 1) {
        return false;
      }
      const current = records.get(channelId);
      if ((current?.version ?? 0) !== expectedVersion) {
        return false;
      }
      records.set(channelId, structuredClone(next));
      return true;
    },
    async list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
  };
}

/**
 * Reads a record through the schema, so a corrupt or foreign value in a
 * shared store is an error rather than a silent default.
 */
export async function readChannelRecord(
  store: ChannelStore,
  channelId: string,
): Promise<ChannelRecord | undefined> {
  const raw = await store.get(channelId);
  if (raw === undefined) return undefined;
  const parsed = channelRecordSchema.safeParse(raw);
  if (!parsed.success || parsed.data.channelId !== channelId) {
    throw new TollwayError(
      "corrupt-channel-record",
      `stored record for channel ${channelId} does not match the channel record schema`,
    );
  }
  return parsed.data;
}

/**
 * Caps on-chain closes per fee-payer key in a rolling window. `@stellar/mpp`'s
 * `feeBudget` covers only closes routed through its `verify()`, not the
 * standalone `close()` the settlement module calls, so Tollway keeps its own.
 */
export interface CloseRateGuard {
  /** Counts one close against `feePayer` at `nowMs`. Resolves false, counting nothing, when the cap is reached. */
  tryAcquire(feePayer: string, nowMs: number): Promise<boolean>;
}

/** Limits for {@link createInMemoryCloseRateGuard}. */
export type CloseRateLimit = {
  /** Most closes one fee payer may send within `windowMs`. */
  maxCloses: number;
  windowMs: number;
};

/**
 * An in-process {@link CloseRateGuard} with a sliding window. Several
 * processes sharing one fee payer need a shared guard; each process running
 * its own allows `maxCloses` per process.
 */
export function createInMemoryCloseRateGuard(limit: CloseRateLimit): CloseRateGuard {
  if (!Number.isSafeInteger(limit.maxCloses) || limit.maxCloses <= 0) {
    throw new TollwayError("invalid-store-config", "maxCloses must be a positive integer");
  }
  if (!Number.isSafeInteger(limit.windowMs) || limit.windowMs <= 0) {
    throw new TollwayError("invalid-store-config", "windowMs must be a positive integer");
  }
  const sent = new Map<string, number[]>();
  return {
    async tryAcquire(feePayer, nowMs) {
      const recent = (sent.get(feePayer) ?? []).filter((at) => nowMs - at < limit.windowMs);
      if (recent.length >= limit.maxCloses) {
        sent.set(feePayer, recent);
        return false;
      }
      recent.push(nowMs);
      sent.set(feePayer, recent);
      return true;
    },
  };
}
