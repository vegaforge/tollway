import { StellarMppError } from "@stellar/mpp";
import { Mppx, type Store, stellar } from "@stellar/mpp/channel/server";
import {
  bytesToBase64Url,
  enumSchema,
  type MppChannelPayment,
  type PaymentOffer,
  type SettlementRef,
  type StellarNetwork,
  TollwayError,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import { Challenge, Credential, Errors } from "mppx";
import { z } from "zod";
import {
  MPP_NETWORK,
  type OnChainChannel,
  readChannelBalanceState,
  readOnChainChannel,
} from "./channel-chain.js";
import {
  type AcceptedVoucher,
  type ChannelRecord,
  type ChannelSettlementRecord,
  type ChannelStore,
  type CloseRateGuard,
  readChannelRecord,
} from "./channel-store.js";

/**
 * MPP channel handler (#173, #174). Accepts off-chain cumulative commitments
 * (vouchers) on an agent's one-way Stellar channel, verifies each one with
 * `@stellar/mpp/channel/server`, and anchors the receipt at
 * `{ kind: "channel-commitment", channelId, sequence }`. See docs/design.md,
 * "Build plan", Phase 2, and docs/mpp-channels.md.
 *
 * A channel is registered before it is challenged: the agent names it in the
 * TOLLWAY-CHANNEL header, and the handler checks the contract on chain (payout
 * address, token, not closing, refund window) and reads the commitment key
 * from the contract itself, never from the request.
 *
 * Every rejection reason starts with a stable code followed by a colon, for
 * example `channel-settling: ...`. The codes are listed in
 * docs/mpp-channels.md so a client can act on them.
 */

/** The wire shape of an MPP channel credential payload, as `@stellar/mpp` 0.7 defines it. */
const channelPayloadSchema = z.strictObject({
  action: enumSchema(["voucher", "close"]),
  amount: z.string().regex(/^[1-9][0-9]*$/, "amount must be a positive integer string"),
  signature: z.string().regex(/^[0-9a-fA-F]{128}$/, "signature must be 128 hex characters"),
});

const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;

/** What `@stellar/mpp` keeps per channel. Read only, never written by Tollway. */
const sdkCumulativeSchema = z.object({ amount: z.string().regex(/^[0-9]+$/) });

/**
 * Decodes an `Authorization: Payment ...` credential for the `stellar/channel`
 * method into an `MppChannelPayment` from `@vegaforge/tollway-core`. Nothing
 * is trusted yet: the handler's `verify` checks that this server issued the
 * challenge.
 */
export function parseMppChannelCredential(
  credential: string,
):
  | { ok: true; payment: MppChannelPayment }
  | { ok: false; kind: "not-channel" | "invalid-channel"; reason: string } {
  let decoded: Credential.Credential;
  try {
    decoded = Credential.deserialize(credential);
  } catch (error) {
    return {
      ok: false,
      kind: "not-channel",
      reason: `malformed mpp credential: ${errorMessage(error)}`,
    };
  }
  const { challenge } = decoded;
  if (challenge.method !== "stellar" || challenge.intent !== "channel") {
    return {
      ok: false,
      kind: "not-channel",
      reason: `mpp credential is for ${challenge.method}/${challenge.intent}, not stellar/channel`,
    };
  }
  const channelId = challenge.request.channel;
  if (typeof channelId !== "string" || !CONTRACT_ADDRESS.test(channelId)) {
    return {
      ok: false,
      kind: "invalid-channel",
      reason: "mpp channel challenge does not name a channel contract",
    };
  }
  const payload = channelPayloadSchema.safeParse(decoded.payload);
  if (!payload.success) {
    return {
      ok: false,
      kind: "invalid-channel",
      reason: `invalid mpp channel payload: ${payload.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }
  return {
    ok: true,
    payment: {
      model: "mpp-channel",
      channelId,
      cumulativeAmount: payload.data.amount,
      signature: payload.data.signature.toLowerCase(),
      action: payload.data.action,
      credential,
    },
  };
}

export type MppChannelVerifyInput = { payment: MppChannelPayment; offer: PaymentOffer };

export type MppChannelVerifyResult =
  | { valid: true; payer: string; nonce: string }
  | { valid: false; reason: string };

export type MppChannelSettleInput = {
  payment: MppChannelPayment;
  offer: PaymentOffer;
  payer: string;
  nonce: string;
};

/**
 * A settled voucher is anchored at its channel and sequence. A close also
 * carries the close transaction hash. A rejection carries the HTTP status the
 * gate answers with.
 */
export type MppChannelSettleResult =
  | { settled: true; settlement: SettlementRef; txHash?: string }
  | ({ settled: false } & MppChannelRefusal);

/**
 * Why the handler refused, as the gate code it answers with (see
 * docs/gate-errors.md). `reason` starts with the channel code listed in
 * docs/mpp-channels.md.
 */
export type MppChannelRefusal = {
  code:
    | "payment-invalid"
    | "channel-refused"
    | "channel-rate-limited"
    | "settlement-in-progress"
    | "facilitator-unavailable";
  reason: string;
  /** For `channel-rate-limited`: when trying again may succeed. */
  retryAfterMs?: number;
};

export type MppChannelChallengeInput = {
  offer: PaymentOffer;
  request: { method: string; url: string };
  /** The channel the agent named in TOLLWAY-CHANNEL. */
  channelId: string;
};

/** The MPP challenge for a registered channel, or why the channel was refused. */
export type MppChannelChallengeResult =
  | { ok: true; headers: Record<string, string> }
  | ({ ok: false } & MppChannelRefusal);

/** What {@link MppChannelHandler.reconcile} found and did. */
export type MppChannelReconcileOutcome =
  | { outcome: "nothing-pending" }
  | { outcome: "committed"; sequence: number }
  | { outcome: "discarded"; sequence: number };

/** Handles mpp-channel payments for the gate. */
export interface MppChannelHandler {
  /** Derived from the voucher itself: channel, cumulative amount and signature. */
  idempotencyKey(input: { payment: MppChannelPayment }): Promise<string>;
  /** Registers the channel on first sight, then builds the MPP challenge for it. */
  challenge(input: MppChannelChallengeInput): Promise<MppChannelChallengeResult>;
  /** Offline checks: provenance, binding to the offer, channel status, increment. */
  verify(input: MppChannelVerifyInput): Promise<MppChannelVerifyResult>;
  /** Hands the voucher to `@stellar/mpp` and records it. Serialised per channel. */
  settle(input: MppChannelSettleInput): Promise<MppChannelSettleResult>;
  /**
   * Resolves a voucher left pending by a crash between `@stellar/mpp`
   * accepting it and Tollway recording it, by reading what `@stellar/mpp`
   * stored. Until then the channel accepts nothing.
   */
  reconcile(channelId: string): Promise<MppChannelReconcileOutcome>;
}

type StellarSigner = NonNullable<stellar.Parameters["feePayer"]>["envelopeSigner"];

/** Configuration for {@link createMppChannelHandler}. */
export type MppChannelOptions = {
  /** Account (G...) the channels must pay out to. Equals the routes' `payTo`. */
  recipient: string;
  /** Token contract (C...) the channels must pay in. Equals the routes' `asset`. */
  currency: string;
  network: StellarNetwork;
  /** HMAC key `mppx` binds challenges to. At least 32 bytes, secret and stable. */
  secretKey: string;
  /**
   * `@stellar/mpp`'s store. Its `update()` must be a linearizable
   * compare-and-set; `Store.memory()` is correct in one process only.
   */
  store: Store.AtomicStore;
  /** Tollway's channel records, shared with the settlement module. */
  channels: ChannelStore;
  /**
   * Shortest refund waiting period, in ledgers, a channel may have. A short one
   * lets a funder dispute and refund before the service can close. Defaults to
   * 17280 (about a day at 5 s ledgers).
   */
  minRefundWaitingPeriod?: number;
  /**
   * Pays for closes the agent asks for with a `close` credential. Without it a
   * close credential is rejected with `close-not-supported`.
   */
  feePayer?: { envelopeSigner: StellarSigner; feeBumpSigner?: StellarSigner };
  /** Public key of the account that pays close fees, for `closeRateGuard`. Required with `feePayer`. */
  feePayerKey?: string;
  /** Caps agent-initiated closes per fee payer. Share it with the settlement module. */
  closeRateGuard?: CloseRateGuard;
  /** Cap on the fee bump of an agent-initiated close, in stroops. */
  maxFeeBumpStroops?: number;
  rpcUrl?: string;
  realm?: string;
  /** Most channels with a live `mppx` method at once. Defaults to 1000. */
  maxActiveChannels?: number;
  /** A channel's `mppx` method is dropped after this long unused. Defaults to 15 minutes. */
  channelIdleMs?: number;
  /**
   * Cap on on-chain registration checks (each costs several RPC simulations),
   * across all callers. Defaults to 60 per minute.
   */
  registrationLimit?: { max: number; windowMs: number };
  /** Called when a voucher the SDK accepted could not be recorded; see `reconcile`. */
  onStoreError?: (error: Error, channelId: string) => void;
  /** Called when the chain after an agent-initiated close does not look closed. */
  onCloseAnomaly?: (info: { channelId: string; detail: string }) => void;
  clock?: () => number;
};

const DEFAULT_MIN_REFUND_WAITING_PERIOD = 17_280;
const DEFAULT_MAX_ACTIVE_CHANNELS = 1000;
const DEFAULT_CHANNEL_IDLE_MS = 15 * 60_000;
const DEFAULT_REGISTRATION_LIMIT = { max: 60, windowMs: 60_000 };

/**
 * The real channel handler, on `mppx` and `@stellar/mpp/channel/server`.
 *
 * Amounts stay integer base units end to end: each channel method is created
 * with `decimals: 0`, so the challenge carries the offer amount unchanged.
 *
 * Order of writes per voucher: Tollway marks the voucher pending, then
 * `@stellar/mpp` verifies it and advances its own cumulative, then Tollway
 * records it as accepted and the gate signs the receipt. A failure in the
 * middle leaves the channel blocked rather than issuing a receipt for a
 * voucher the SDK did not accept.
 */
export function createMppChannelHandler(options: MppChannelOptions): MppChannelHandler {
  if (!options.secretKey) {
    throw new TypeError("createMppChannelHandler: secretKey is required");
  }
  if (typeof options.store?.update !== "function") {
    throw new TypeError("createMppChannelHandler: store must be an atomic mppx store");
  }
  if (options.feePayer && !options.feePayerKey) {
    throw new TypeError("createMppChannelHandler: feePayerKey is required with feePayer");
  }
  const minRefundWaitingPeriod =
    options.minRefundWaitingPeriod ?? DEFAULT_MIN_REFUND_WAITING_PERIOD;
  const maxActive = options.maxActiveChannels ?? DEFAULT_MAX_ACTIVE_CHANNELS;
  const idleMs = options.channelIdleMs ?? DEFAULT_CHANNEL_IDLE_MS;
  const registrationLimit = options.registrationLimit ?? DEFAULT_REGISTRATION_LIMIT;
  for (const [name, value] of [
    ["minRefundWaitingPeriod", minRefundWaitingPeriod],
    ["maxActiveChannels", maxActive],
    ["channelIdleMs", idleMs],
    ["registrationLimit.max", registrationLimit.max],
    ["registrationLimit.windowMs", registrationLimit.windowMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (name === "minRefundWaitingPeriod" ? 0 : 1)) {
      throw new TypeError(`createMppChannelHandler: ${name} must be a positive integer`);
    }
  }
  const clock = options.clock ?? Date.now;
  const realm = options.realm ?? "tollway";
  const chain = {
    network: options.network,
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  };

  function createMethod(record: ChannelRecord) {
    return Mppx.create({
      secretKey: options.secretKey,
      realm,
      methods: [
        stellar.channel({
          channel: record.channelId,
          commitmentKey: record.commitmentKey,
          store: options.store,
          network: MPP_NETWORK[options.network],
          recipient: options.recipient,
          currency: options.currency,
          decimals: 0,
          checkOnChainState: true,
          ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
          ...(options.feePayer ? { feePayer: options.feePayer } : {}),
          ...(options.maxFeeBumpStroops ? { maxFeeBumpStroops: options.maxFeeBumpStroops } : {}),
        }),
      ],
    });
  }
  type ChannelMethod = ReturnType<typeof createMethod>;

  // One mppx method per channel, because a stellar.channel method is bound to
  // one contract. Bounded by count and idle time so unauthenticated traffic
  // cannot grow it without limit.
  const methods = new Map<string, { method: ChannelMethod; lastUsed: number }>();
  function methodFor(record: ChannelRecord): ChannelMethod {
    const now = clock();
    for (const [id, entry] of methods) {
      if (now - entry.lastUsed >= idleMs) methods.delete(id);
    }
    const existing = methods.get(record.channelId);
    if (existing) {
      // Re-inserting keeps the map in least-recently-used order.
      methods.delete(record.channelId);
      methods.set(record.channelId, { method: existing.method, lastUsed: now });
      return existing.method;
    }
    while (methods.size >= maxActive) {
      const oldest = methods.keys().next();
      if (oldest.done) break;
      methods.delete(oldest.value);
    }
    const method = createMethod(record);
    methods.set(record.channelId, { method, lastUsed: now });
    return method;
  }

  const registrations: number[] = [];
  /** Counts a registration check, or says how long until one is allowed. */
  function registrationWaitMs(): number {
    const now = clock();
    while (
      registrations.length > 0 &&
      now - (registrations[0] ?? now) >= registrationLimit.windowMs
    ) {
      registrations.shift();
    }
    if (registrations.length >= registrationLimit.max) {
      return registrationLimit.windowMs - (now - (registrations[0] ?? now));
    }
    registrations.push(now);
    return 0;
  }

  // Vouchers on one channel are settled one at a time in this process; across
  // processes the version compare-and-set on the record does the same job.
  const channelLocks = new Map<string, Promise<void>>();
  async function withChannelLock<T>(channelId: string, work: () => Promise<T>): Promise<T> {
    const previous = channelLocks.get(channelId) ?? Promise.resolve();
    let release = (): void => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    channelLocks.set(channelId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (channelLocks.get(channelId) === tail) channelLocks.delete(channelId);
    }
  }

  function offerMismatch(offer: PaymentOffer): string | null {
    if (offer.network !== options.network) {
      return `mpp channel handler is configured for ${options.network}, not ${offer.network}`;
    }
    if (offer.payTo !== options.recipient) {
      return "mpp channel handler recipient does not match the offer payTo";
    }
    if (offer.asset !== options.currency) {
      return "mpp channel handler currency does not match the offer asset";
    }
    return null;
  }

  async function register(
    channelId: string,
    offer: PaymentOffer,
  ): Promise<{ ok: true; record: ChannelRecord } | ({ ok: false } & MppChannelRefusal)> {
    const existing = await readChannelRecord(options.channels, channelId);
    if (existing) {
      const problem = statusProblem(existing);
      return problem
        ? { ok: false, code: "channel-refused", reason: problem }
        : { ok: true, record: existing };
    }
    const waitMs = registrationWaitMs();
    if (waitMs > 0) {
      return {
        ok: false,
        code: "channel-rate-limited",
        reason: "registration-rate-limited: too many channel registrations, retry later",
        retryAfterMs: waitMs,
      };
    }
    let onChain: OnChainChannel;
    try {
      onChain = await readOnChainChannel(channelId, chain);
    } catch (error) {
      // Fail closed: a channel that cannot be checked is not challenged.
      return {
        ok: false,
        code: "facilitator-unavailable",
        reason: `channel-state-unavailable: could not read channel ${channelId} on chain (${errorMessage(error)})`,
      };
    }
    const refused = registrationProblem(onChain, offer, minRefundWaitingPeriod);
    if (refused) return { ok: false, code: "channel-refused", reason: refused };
    const record: ChannelRecord = {
      channelId,
      network: offer.network,
      payer: onChain.from,
      payTo: onChain.to,
      asset: onChain.token,
      commitmentKey: onChain.commitmentKey,
      refundWaitingPeriod: onChain.refundWaitingPeriod,
      registeredAt: clock(),
      status: "open",
      version: 1,
    };
    if (await options.channels.compareAndSet(channelId, 0, record)) {
      return { ok: true, record };
    }
    // Another request registered it first; use what it stored.
    const raced = await readChannelRecord(options.channels, channelId);
    if (!raced) {
      return {
        ok: false,
        code: "facilitator-unavailable",
        reason: "channel-state-unavailable: channel registration did not persist",
      };
    }
    return { ok: true, record: raced };
  }

  async function idempotencyKey(payment: MppChannelPayment): Promise<string> {
    const material = `${payment.channelId}\n${payment.cumulativeAmount}\n${payment.signature.toLowerCase()}`;
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(utf8Bytes(material)));
    return bytesToBase64Url(new Uint8Array(digest));
  }

  async function sdkCumulative(channelId: string): Promise<bigint> {
    const raw = await options.store.get(`stellar:channel:cumulative:${channelId}`);
    if (raw === null || raw === undefined) return 0n;
    const parsed = sdkCumulativeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TollwayError(
        "corrupt-channel-record",
        `@stellar/mpp cumulative record for channel ${channelId} is not in the expected shape`,
      );
    }
    return BigInt(parsed.data.amount);
  }

  /** Writes `next` over `current`, bumping the version. */
  async function write(
    current: ChannelRecord,
    next: Omit<ChannelRecord, "version">,
  ): Promise<ChannelRecord | null> {
    const record: ChannelRecord = { ...next, version: current.version + 1 };
    return (await options.channels.compareAndSet(current.channelId, current.version, record))
      ? record
      : null;
  }

  async function commitPending(
    current: ChannelRecord,
    settlementPatch?: Partial<NonNullable<ChannelRecord["settlement"]>>,
    status?: ChannelRecord["status"],
  ): Promise<ChannelRecord | null> {
    const { pending, ...rest } = current;
    if (!pending) return current;
    const { action: _action, ...voucher } = pending;
    return write(current, {
      ...rest,
      latest: voucher,
      ...(status ? { status } : {}),
      ...(settlementPatch && current.settlement
        ? { settlement: { ...current.settlement, ...settlementPatch } }
        : {}),
    });
  }

  async function dropPending(
    current: ChannelRecord,
    lastError?: string,
  ): Promise<ChannelRecord | null> {
    const { pending: _pending, ...rest } = current;
    return write(current, {
      ...rest,
      ...(lastError && current.settlement
        ? { settlement: { ...current.settlement, lastError } }
        : {}),
    });
  }

  async function settleVoucher(input: MppChannelSettleInput): Promise<MppChannelSettleResult> {
    const { payment, offer } = input;
    const record = await readChannelRecord(options.channels, payment.channelId);
    const problem = acceptanceProblem(record, payment, offer);
    if (problem || !record) {
      return {
        settled: false,
        code: "payment-invalid",
        reason: problem ?? "channel-not-registered",
      };
    }
    const isClose = payment.action === "close";
    const sequence = (record.latest?.sequence ?? 0) + 1;
    const pendingVoucher: NonNullable<ChannelRecord["pending"]> = {
      sequence,
      cumulativeAmount: payment.cumulativeAmount,
      signature: payment.signature,
      acceptedAt: clock(),
      action: payment.action,
    };

    let balanceBefore: string | undefined;
    if (isClose) {
      if (!options.feePayerKey) {
        return { settled: false, code: "payment-invalid", reason: closeNotSupported() };
      }
      if (
        options.closeRateGuard &&
        !(await options.closeRateGuard.tryAcquire(options.feePayerKey, clock()))
      ) {
        return {
          settled: false,
          code: "channel-rate-limited",
          reason: "close-rate-limited: the close budget for this fee payer is spent, retry later",
        };
      }
      try {
        balanceBefore = (await readChannelBalanceState(payment.channelId, chain)).balance;
      } catch (error) {
        return {
          settled: false,
          code: "facilitator-unavailable",
          reason: `channel-state-unavailable: could not read the balance before closing (${errorMessage(error)})`,
        };
      }
    }

    const claimed = await write(record, {
      ...record,
      pending: pendingVoucher,
      ...(isClose
        ? {
            status: "settling" as const,
            settlement: {
              startedAt: clock(),
              trigger: "agent" as const,
              retryable: false,
              ...(balanceBefore !== undefined ? { balanceBefore } : {}),
            },
          }
        : {}),
    });
    if (!claimed) {
      return {
        settled: false,
        code: "settlement-in-progress",
        reason: "channel-busy: the channel changed while this voucher was checked, retry",
      };
    }

    let reference: string;
    try {
      const receipt = await methodFor(claimed).verifyCredential(payment.credential, {
        request: { amount: offer.amount },
        scope: offer.resource,
      });
      reference = receipt.reference;
    } catch (error) {
      return settleFailure(claimed, payment, error);
    }

    if (!isClose) {
      const committed = await commitPending(claimed);
      if (!committed) {
        options.onStoreError?.(
          new Error(
            "accepted voucher could not be recorded; the channel is blocked until reconcile",
          ),
          payment.channelId,
        );
      }
      return {
        settled: true,
        settlement: { kind: "channel-commitment", channelId: payment.channelId, sequence },
      };
    }

    const amount = BigInt(payment.cumulativeAmount);
    const before = BigInt(balanceBefore ?? "0");
    const record_: ChannelSettlementRecord = {
      channelId: payment.channelId,
      settledAmount: payment.cumulativeAmount,
      returnedRemainder: (before > amount ? before - amount : 0n).toString(),
      txHash: reference,
    };
    const closed = await commitPending(claimed, { record: record_, closedAt: clock() }, "closed");
    if (!closed) {
      options.onStoreError?.(
        new Error("closed channel could not be recorded; the channel is blocked until reconcile"),
        payment.channelId,
      );
    }
    await checkClosedOnChain(payment.channelId);
    return {
      settled: true,
      settlement: { kind: "channel-commitment", channelId: payment.channelId, sequence },
      txHash: reference,
    };
  }

  /**
   * `@stellar/mpp` refused or failed. For a voucher, what the SDK stored
   * decides: if its cumulative moved to this voucher the SDK accepted it
   * after all, otherwise the pending mark is dropped and the voucher is
   * rejected. A close that failed may still have been broadcast, so the
   * channel stays settling for the settlement module's `resolve`.
   */
  async function settleFailure(
    claimed: ChannelRecord,
    payment: MppChannelPayment,
    error: unknown,
  ): Promise<MppChannelSettleResult> {
    const accepted = (await sdkCumulative(payment.channelId)) === BigInt(payment.cumulativeAmount);
    if (payment.action === "close") {
      const message = errorMessage(error);
      const next = accepted
        ? await commitPending(claimed, { lastError: message })
        : await dropPending(claimed, message);
      if (!next) {
        options.onStoreError?.(new Error("failed close could not be recorded"), payment.channelId);
      }
      throw new TollwayError(
        "outcome-unknown",
        `mpp channel close for ${payment.channelId} failed and may have reached the chain; the channel stays settling until resolved: ${message}`,
        { cause: error },
      );
    }
    if (accepted) {
      const committed = await commitPending(claimed);
      if (!committed) {
        options.onStoreError?.(
          new Error("accepted voucher could not be recorded"),
          payment.channelId,
        );
      }
      return {
        settled: true,
        settlement: {
          kind: "channel-commitment",
          channelId: payment.channelId,
          sequence: claimed.pending?.sequence ?? 0,
        },
      };
    }
    const released = await dropPending(claimed);
    if (!released) {
      options.onStoreError?.(
        new Error("rejected voucher's pending mark could not be cleared"),
        payment.channelId,
      );
    }
    return {
      settled: false,
      code: "payment-invalid",
      reason: `mpp-channel-rejected: ${rejectionMessage(error)}`,
    };
  }

  async function checkClosedOnChain(channelId: string): Promise<void> {
    try {
      const after = await readChannelBalanceState(channelId, chain);
      if (after.closeEffectiveAtLedger === null || after.balance !== "0") {
        options.onCloseAnomaly?.({
          channelId,
          detail: `after close: balance ${after.balance}, closeEffectiveAtLedger ${String(after.closeEffectiveAtLedger)}`,
        });
      }
    } catch (error) {
      options.onCloseAnomaly?.({
        channelId,
        detail: `could not read state after close: ${errorMessage(error)}`,
      });
    }
  }

  return {
    async idempotencyKey({ payment }) {
      return idempotencyKey(payment);
    },

    async challenge({ offer, request, channelId }) {
      const mismatch = offerMismatch(offer);
      if (mismatch) throw new TollwayError("payment-failed", mismatch);
      if (!CONTRACT_ADDRESS.test(channelId)) {
        return {
          ok: false,
          code: "channel-refused",
          reason: "channel-invalid: TOLLWAY-CHANNEL is not a contract address",
        };
      }
      const registered = await register(channelId, offer);
      if (!registered.ok) return registered;
      const url = new URL(request.url, `https://${realm}`);
      const result = await methodFor(registered.record).channel({
        amount: offer.amount,
        scope: offer.resource,
      })(new Request(url, { method: request.method }));
      if (result.status !== 402) {
        throw new TollwayError(
          "payment-failed",
          "mppx accepted a request that carried no credential",
        );
      }
      const headers: Record<string, string> = {};
      result.challenge.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return { ok: true, headers };
    },

    async verify({ payment, offer }) {
      const mismatch = offerMismatch(offer);
      if (mismatch) return { valid: false, reason: mismatch };
      let credential: Credential.Credential;
      try {
        credential = Credential.deserialize(payment.credential);
      } catch (error) {
        return { valid: false, reason: `malformed mpp credential: ${errorMessage(error)}` };
      }
      const { challenge } = credential;
      if (!Challenge.verify(challenge, { secretKey: options.secretKey })) {
        return { valid: false, reason: "mpp challenge was not issued by this server" };
      }
      if (challenge.request.channel !== payment.channelId) {
        return {
          valid: false,
          reason: "mpp channel credential names a different channel than its challenge",
        };
      }
      if (challenge.request.amount !== offer.amount) {
        return { valid: false, reason: "mpp credential amount does not match the offer" };
      }
      const record = await readChannelRecord(options.channels, payment.channelId);
      const problem = acceptanceProblem(record, payment, offer);
      if (problem || !record) return { valid: false, reason: problem ?? "channel-not-registered" };
      if (payment.action === "close" && !options.feePayer) {
        return { valid: false, reason: closeNotSupported() };
      }
      return { valid: true, payer: record.payer, nonce: await idempotencyKey(payment) };
    },

    async settle(input) {
      return withChannelLock(input.payment.channelId, () => settleVoucher(input));
    },

    async reconcile(channelId) {
      return withChannelLock(channelId, async () => {
        const record = await readChannelRecord(options.channels, channelId);
        if (!record?.pending) return { outcome: "nothing-pending" as const };
        const { sequence } = record.pending;
        const stored = await sdkCumulative(channelId);
        if (stored === BigInt(record.pending.cumulativeAmount)) {
          if (!(await commitPending(record))) {
            throw new TollwayError(
              "corrupt-channel-record",
              `channel ${channelId} changed during reconcile`,
            );
          }
          return { outcome: "committed" as const, sequence };
        }
        if (stored === BigInt(record.latest?.cumulativeAmount ?? "0")) {
          if (!(await dropPending(record))) {
            throw new TollwayError(
              "corrupt-channel-record",
              `channel ${channelId} changed during reconcile`,
            );
          }
          return { outcome: "discarded" as const, sequence };
        }
        throw new TollwayError(
          "settlement-mismatch",
          `@stellar/mpp holds cumulative ${stored} for channel ${channelId}, which matches neither the pending nor the accepted voucher`,
        );
      });
    },
  };
}

function closeNotSupported(): string {
  return "close-not-supported: this service does not accept close credentials; send a voucher";
}

/** Null when the channel can take vouchers, otherwise the coded reason. */
function statusProblem(record: ChannelRecord): string | null {
  switch (record.status) {
    case "settling":
      return `channel-settling: channel ${record.channelId} is being closed; open a new channel`;
    case "closed":
      return `channel-closed: channel ${record.channelId} is closed; open a new channel`;
    case "open":
      return record.pending
        ? `channel-pending-reconciliation: channel ${record.channelId} has an unrecorded voucher; retry later`
        : null;
  }
}

/** The on-chain checks a channel must pass before it is challenged. */
export function registrationProblem(
  onChain: OnChainChannel,
  offer: PaymentOffer,
  minRefundWaitingPeriod: number,
): string | null {
  if (onChain.to !== offer.payTo) {
    return "channel-recipient-mismatch: the channel does not pay out to this service's payTo";
  }
  if (onChain.token !== offer.asset) {
    return "channel-token-mismatch: the channel pays in a different token than the offer asset";
  }
  if (onChain.closeEffectiveAtLedger !== null) {
    return "channel-closing: the channel is closing or closed on chain";
  }
  if (onChain.refundWaitingPeriod < minRefundWaitingPeriod) {
    return `channel-refund-period-too-short: refund waiting period ${onChain.refundWaitingPeriod} is below the required ${minRefundWaitingPeriod} ledgers`;
  }
  return null;
}

/**
 * Null when `payment` may be accepted on `record` against `offer`, otherwise
 * the coded reason. The increment must equal the offer amount exactly, so
 * each receipt answers exactly one paid request.
 */
export function acceptanceProblem(
  record: ChannelRecord | undefined,
  payment: MppChannelPayment,
  offer: PaymentOffer,
): string | null {
  if (!record) {
    return `channel-not-registered: channel ${payment.channelId} is not registered; send TOLLWAY-CHANNEL to get a challenge`;
  }
  if (
    record.network !== offer.network ||
    record.payTo !== offer.payTo ||
    record.asset !== offer.asset
  ) {
    return "channel-offer-mismatch: the channel was registered for a different network, payee or asset";
  }
  const status = statusProblem(record);
  if (status) return status;
  const amount = BigInt(payment.cumulativeAmount);
  const latest: AcceptedVoucher | undefined = record.latest;
  if (latest) {
    const previous = BigInt(latest.cumulativeAmount);
    if (amount === previous) {
      return latest.signature === payment.signature.toLowerCase()
        ? "voucher-already-accepted: this voucher was already paid for; send the next cumulative amount"
        : "commitment-conflict: a different signature was already accepted at this cumulative amount";
    }
    if (amount < previous) {
      return `stale-cumulative: cumulative ${amount} is below the accepted ${previous}`;
    }
  }
  const increment = amount - BigInt(latest?.cumulativeAmount ?? "0");
  if (increment !== BigInt(offer.amount)) {
    return `wrong-increment: the voucher adds ${increment}, the offer costs ${offer.amount}`;
  }
  return null;
}

const TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function rejectionMessage(error: unknown): string {
  if (error instanceof Errors.PaymentError || error instanceof StellarMppError) {
    return error.message;
  }
  if (error instanceof Error) {
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code)) {
      return `network failure while verifying (${error.message})`;
    }
  }
  return `invalid payment: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
