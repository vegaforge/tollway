import { fromBaseUnits, StellarMppError } from "@stellar/mpp";
import { getChannelState, Mppx, type Store, stellar } from "@stellar/mpp/channel/server";
import type {
  MppChannelPayment,
  PaymentOffer,
  SettlementRef,
  StellarNetwork,
} from "@vegaforge/tollway-core";
import { Challenge, Credential, Errors } from "mppx";
import { mockAccount, mockHex } from "./hash.js";

/**
 * MPP channel handler (#173). Accepts off-chain cumulative commitments
 * (vouchers) from an agent's one-way Stellar channel, verifies them with
 * `@stellar/mpp/channel/server` and on-chain channel checks, and returns a
 * canonical receipt anchored at `{ kind: "channel-commitment", channelId,
 * sequence }`.
 *
 * Unlike `mpp-charge`, a `stellar.channel` method instance in `mppx` is
 * bound to a single channel contract address, so the handler maintains one
 * `Mppx` instance per registered channel.
 */

const MPP_NETWORK: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const INTEGER_AMOUNT = /^[0-9]+$/;

/** A registered one-way payment channel known to the service. */
export type RegisteredChannel = {
  channelId: string;
  /**
   * Funder's Ed25519 commitment public key (from chain/deployment, never
   * from the client request).
   */
  commitmentKey: string;
  /** Funder's Stellar account (`G...`). */
  payer: string;
  network: StellarNetwork;
  /** SEP-41 token contract (`C...`). */
  asset: string;
  /** Service recipient (`G...` or `C...`). */
  recipient: string;
  refundWaitingPeriod?: number;
};

/** Lookup and registration for channels the gate accepts vouchers from. */
export interface ChannelRegistry {
  get(channelId: string): Promise<RegisteredChannel | undefined>;
  list(): Promise<readonly RegisteredChannel[]>;
  register?(channel: RegisteredChannel): Promise<void>;
}

export function createInMemoryChannelRegistry(
  initial: readonly RegisteredChannel[] = [],
): ChannelRegistry & { register(channel: RegisteredChannel): Promise<void> } {
  const channels = new Map<string, RegisteredChannel>();
  for (const ch of initial) {
    channels.set(ch.channelId, ch);
  }
  return {
    async get(channelId) {
      return channels.get(channelId);
    },
    async list() {
      return [...channels.values()];
    },
    async register(channel) {
      channels.set(channel.channelId, channel);
    },
  };
}

/** An accepted off-chain cumulative voucher persisted by the service. */
export type AcceptedVoucher = {
  channelId: string;
  sequence: number;
  cumulativeAmount: string;
  commitment: string;
  payer: string;
  acceptedAt: string;
};

/** Durable store for accepted channel vouchers (used for replay, monotonicity, and #174 settlement). */
export interface VoucherStore {
  getLatest(channelId: string): Promise<AcceptedVoucher | undefined>;
  getBySequence(channelId: string, sequence: number): Promise<AcceptedVoucher | undefined>;
  record(voucher: AcceptedVoucher): Promise<void>;
  listLatest(): Promise<readonly AcceptedVoucher[]>;
}

export function createInMemoryVoucherStore(options: { now?: () => string } = {}): VoucherStore {
  const now = options.now ?? (() => new Date().toISOString());
  const byChannel = new Map<string, Map<number, AcceptedVoucher>>();
  const latestByChannel = new Map<string, AcceptedVoucher>();

  return {
    async getLatest(channelId) {
      return latestByChannel.get(channelId);
    },
    async getBySequence(channelId, sequence) {
      return byChannel.get(channelId)?.get(sequence);
    },
    async record(voucher) {
      let seqMap = byChannel.get(voucher.channelId);
      if (!seqMap) {
        seqMap = new Map<number, AcceptedVoucher>();
        byChannel.set(voucher.channelId, seqMap);
      }
      const normalized: AcceptedVoucher = {
        ...voucher,
        acceptedAt: voucher.acceptedAt || now(),
      };
      seqMap.set(voucher.sequence, normalized);
      const current = latestByChannel.get(voucher.channelId);
      if (!current || voucher.sequence >= current.sequence) {
        latestByChannel.set(voucher.channelId, normalized);
      }
    },
    async listLatest() {
      return [...latestByChannel.values()];
    },
  };
}

/** An MPP channel payment carrying the optional raw `Authorization: Payment ...` credential. */
export type MppChannelGatePayment = MppChannelPayment & {
  credential?: string;
  action?: "voucher" | "close";
};

export type MppChannelVerifyInput = {
  payment: MppChannelGatePayment;
  offer: PaymentOffer;
};

export type MppChannelVerifyResult =
  | { valid: true; payer: string; nonce: string }
  | { valid: false; reason: string };

export type MppChannelSettleInput = {
  payment: MppChannelGatePayment;
  offer: PaymentOffer;
  payer: string;
  nonce: string;
};

export type MppChannelSettleResult =
  | { settled: true; settlement: SettlementRef; txHash?: string }
  | { settled: false; reason: string };

export type MppChannelChallengeInput = {
  offer: PaymentOffer;
  request: { method: string; url: string; headers?: Record<string, string | string[] | undefined> };
  channelId?: string;
};

export type MppChannelChallenge = {
  status: number;
  headers: Record<string, string>;
  body: string | null;
};

export interface MppChannelHandler {
  idempotencyKey?(input: { payment: MppChannelGatePayment }): Promise<string | undefined>;
  challenge?(input: MppChannelChallengeInput): Promise<MppChannelChallenge>;
  verify(input: MppChannelVerifyInput): Promise<MppChannelVerifyResult>;
  settle(input: MppChannelSettleInput): Promise<MppChannelSettleResult>;
}

/** On-chain channel state needed to validate a voucher before accepting it. */
export type OnChainChannelSnapshot = {
  balance: string;
  token: string;
  to: string;
  closeEffectiveAtLedger: number | null;
  currentLedger: number;
};

export type ChannelStateReader = (input: {
  channel: string;
  network: StellarNetwork;
  rpcUrl?: string;
}) => Promise<OnChainChannelSnapshot>;

export type MppChannelOptions = {
  recipient: string;
  currency: string;
  network: StellarNetwork;
  secretKey: string;
  store: Store.AtomicStore;
  registry: ChannelRegistry;
  voucherStore: VoucherStore;
  /** Token decimals used by `fromBaseUnits` when building challenges. Defaults to 7 (Stellar SAC). */
  decimals?: number;
  rpcUrl?: string;
  realm?: string;
  feePayer?: {
    envelopeSigner: NonNullable<stellar.Parameters["feePayer"]>["envelopeSigner"];
    feeBumpSigner?: NonNullable<stellar.Parameters["feePayer"]>["feeBumpSigner"];
  };
  /** Optional custom on-chain state reader (defaults to `@stellar/mpp/channel/server` `getChannelState`). */
  readChannelState?: ChannelStateReader;
  onDisputeDetected?: (info: { channelId: string; closeEffectiveAtLedger: number }) => void | Promise<void>;
  /** Optional hook for `action: "close"` credentials settled on chain (#174). */
  onCloseCredential?: (input: {
    channelId: string;
    sequence: number;
    cumulativeAmount: string;
    commitment: string;
    payer: string;
  }) => Promise<{ txHash: string }>;
  now?: () => string;
};

/**
 * Parses an `Authorization: Payment ...` credential into an {@link MppChannelGatePayment}
 * when the credential is for the `channel` intent, or returns `undefined` otherwise.
 */
export function parseMppChannelCredential(authorizationValue: string): MppChannelGatePayment | undefined {
  let credential: ReturnType<typeof Credential.deserialize>;
  try {
    credential = Credential.deserialize(authorizationValue);
  } catch {
    return undefined;
  }
  const challenge = credential.challenge as { intent?: string; request?: Record<string, unknown> };
  if (challenge?.intent !== "channel") {
    return undefined;
  }
  const payload = (credential.payload ?? {}) as Record<string, unknown>;
  const channelId =
    typeof payload.channel === "string"
      ? payload.channel
      : typeof challenge.request?.channel === "string"
        ? challenge.request.channel
        : "";
  const cumulativeAmount =
    typeof payload.amount === "string"
      ? payload.amount
      : typeof payload.cumulativeAmount === "string"
        ? payload.cumulativeAmount
        : "";
  const commitment =
    typeof payload.signature === "string"
      ? payload.signature
      : typeof payload.commitment === "string"
        ? payload.commitment
        : "";
  const sequence =
    typeof payload.sequence === "number" && Number.isInteger(payload.sequence)
      ? payload.sequence
      : 0;
  const action = payload.action === "close" ? "close" : "voucher";

  return {
    model: "mpp-channel",
    channelId,
    sequence,
    cumulativeAmount,
    commitment,
    credential: authorizationValue,
    action,
  };
}

/** Returns true when an `Authorization: Payment ...` credential carries `intent === "channel"`. */
export function isMppChannelCredential(authorizationValue: string): boolean {
  try {
    const credential = Credential.deserialize(authorizationValue);
    return (credential.challenge as { intent?: string })?.intent === "channel";
  } catch {
    return false;
  }
}

function channelNonce(channelId: string, sequence: number): string {
  return `${channelId}:${sequence}`;
}

function validateVoucherShape(payment: MppChannelGatePayment): string | null {
  if (!payment.channelId) return "missing channelId";
  if (!Number.isInteger(payment.sequence) || payment.sequence < 0) {
    return "sequence must be a non-negative integer";
  }
  if (!INTEGER_AMOUNT.test(payment.cumulativeAmount)) {
    return "cumulativeAmount must be a non-negative integer string";
  }
  if (!payment.commitment) return "missing commitment signature";
  return null;
}

/**
 * Offline MPP channel handler for tests and demos. Enforces channel
 * registration, sequence monotonicity, idempotent replay of identical
 * vouchers, conflict detection, and optional mock on-chain checks.
 */
export function createMockMppChannelHandler(
  options: {
    registry?: ChannelRegistry;
    voucherStore?: VoucherStore;
    readChannelState?: ChannelStateReader;
    now?: () => string;
  } = {},
): MppChannelHandler {
  const voucherStore = options.voucherStore ?? createInMemoryVoucherStore({ now: options.now });
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async idempotencyKey({ payment }) {
      if (!payment.channelId || !Number.isInteger(payment.sequence)) return undefined;
      return channelNonce(payment.channelId, payment.sequence);
    },

    async verify({ payment, offer }) {
      const shapeError = validateVoucherShape(payment);
      if (shapeError) {
        return { valid: false, reason: shapeError };
      }

      const registered = options.registry ? await options.registry.get(payment.channelId) : undefined;
      if (options.registry && !registered) {
        return { valid: false, reason: `channel-not-found: channel ${payment.channelId} is not registered` };
      }
      if (registered) {
        if (registered.network !== offer.network) {
          return {
            valid: false,
            reason: `channel ${payment.channelId} is on ${registered.network}, not ${offer.network}`,
          };
        }
        if (registered.asset !== offer.asset) {
          return { valid: false, reason: "channel asset does not match offer asset" };
        }
        if (registered.recipient !== offer.payTo) {
          return { valid: false, reason: "channel recipient does not match offer payTo" };
        }
      }

      const existingAtSeq = await voucherStore.getBySequence(payment.channelId, payment.sequence);
      if (existingAtSeq) {
        if (
          existingAtSeq.cumulativeAmount === payment.cumulativeAmount &&
          existingAtSeq.commitment === payment.commitment
        ) {
          return {
            valid: true,
            payer: existingAtSeq.payer,
            nonce: channelNonce(payment.channelId, payment.sequence),
          };
        }
        return {
          valid: false,
          reason: `commitment-conflict: sequence ${payment.sequence} already accepted with a different commitment`,
        };
      }

      const latest = await voucherStore.getLatest(payment.channelId);
      if (latest) {
        if (payment.sequence <= latest.sequence) {
          return {
            valid: false,
            reason: `stale sequence ${payment.sequence}; latest accepted is ${latest.sequence}`,
          };
        }
        if (BigInt(payment.cumulativeAmount) <= BigInt(latest.cumulativeAmount)) {
          return {
            valid: false,
            reason: `non-monotonic cumulativeAmount ${payment.cumulativeAmount} <= ${latest.cumulativeAmount}`,
          };
        }
      }

      const previousAmount = BigInt(latest?.cumulativeAmount ?? "0");
      const increment = BigInt(payment.cumulativeAmount) - previousAmount;
      if (increment < BigInt(offer.amount)) {
        return {
          valid: false,
          reason: `voucher increment ${increment.toString()} is below offer amount ${offer.amount}`,
        };
      }

      if (options.readChannelState) {
        const state = await options.readChannelState({
          channel: payment.channelId,
          network: offer.network,
        });
        if (state.closeEffectiveAtLedger !== null) {
          return { valid: false, reason: "channel is closing or closed on chain" };
        }
        if (state.token !== offer.asset || state.to !== offer.payTo) {
          return { valid: false, reason: "on-chain channel token or recipient mismatch" };
        }
        if (BigInt(state.balance) < BigInt(payment.cumulativeAmount)) {
          return { valid: false, reason: "on-chain channel balance is below cumulativeAmount" };
        }
      }

      const payer = registered?.payer ?? mockAccount(payment.channelId);
      return {
        valid: true,
        payer,
        nonce: channelNonce(payment.channelId, payment.sequence),
      };
    },

    async settle({ payment, payer }) {
      const existingAtSeq = await voucherStore.getBySequence(payment.channelId, payment.sequence);
      if (!existingAtSeq) {
        await voucherStore.record({
          channelId: payment.channelId,
          sequence: payment.sequence,
          cumulativeAmount: payment.cumulativeAmount,
          commitment: payment.commitment,
          payer,
          acceptedAt: now(),
        });
      }
      return {
        settled: true,
        settlement: {
          kind: "channel-commitment",
          channelId: payment.channelId,
          sequence: payment.sequence,
        },
        ...(payment.action === "close"
          ? { txHash: mockHex(`${payment.channelId}:${payment.sequence}:close`) }
          : {}),
      };
    },
  };
}

/**
 * Real MPP channel handler backed by `@stellar/mpp/channel/server` and `mppx`.
 * Maintains one `Mppx` / `stellar.channel` instance per registered channel
 * because `mppx` keys methods by `${name}/${intent}` and each `stellar.channel`
 * is bound to a single channel contract.
 */
export function createMppChannelHandler(options: MppChannelOptions): MppChannelHandler {
  if (!options.secretKey) {
    throw new TypeError("createMppChannelHandler: secretKey is required");
  }
  if (typeof options.store?.update !== "function") {
    throw new TypeError("createMppChannelHandler: store must be an atomic mppx store");
  }
  const decimals = options.decimals ?? 7;
  const network = MPP_NETWORK[options.network];
  const realm = options.realm ?? "tollway";
  const now = options.now ?? (() => new Date().toISOString());
  const readChannelState: ChannelStateReader =
    options.readChannelState ??
    (async ({ channel, network: net, rpcUrl }) => {
      const state = await getChannelState({
        channel,
        network: MPP_NETWORK[net],
        rpcUrl: rpcUrl ?? options.rpcUrl,
      });
      return {
        balance: String(state.balance),
        token: state.token,
        to: state.to,
        closeEffectiveAtLedger: state.closeEffectiveAtLedger ?? null,
        currentLedger: state.currentLedger,
      };
    });

  const channelInstances = new Map<string, ReturnType<typeof Mppx.create>>();

  function getMppxForChannel(registered: RegisteredChannel): ReturnType<typeof Mppx.create> {
    const existing = channelInstances.get(registered.channelId);
    if (existing) return existing;

    const instance = Mppx.create({
      secretKey: options.secretKey,
      realm,
      methods: [
        stellar.channel({
          channel: registered.channelId,
          commitmentKey: registered.commitmentKey,
          store: options.store,
          network,
          recipient: options.recipient,
          currency: options.currency,
          checkOnChainState: true,
          rpcUrl: options.rpcUrl,
          feePayer: options.feePayer,
          onDisputeDetected: (event: { effectiveAtLedger?: number }) => {
            if (options.onDisputeDetected && event.effectiveAtLedger !== undefined) {
              void options.onDisputeDetected({
                channelId: registered.channelId,
                closeEffectiveAtLedger: event.effectiveAtLedger,
              });
            }
          },
        }),
      ],
    });
    channelInstances.set(registered.channelId, instance);
    return instance;
  }

  return {
    async idempotencyKey({ payment }) {
      if (!payment.channelId || !Number.isInteger(payment.sequence)) return undefined;
      return channelNonce(payment.channelId, payment.sequence);
    },

    async challenge({ offer, request, channelId }) {
      const targetId =
        channelId ??
        (request.headers?.["x-tollway-channel"] as string | undefined);
      const registered = targetId
        ? await options.registry.get(targetId)
        : (await options.registry.list()).find(
            (ch) =>
              ch.network === offer.network &&
              ch.asset === offer.asset &&
              ch.recipient === offer.payTo,
          );
      if (!registered) {
        return { status: 402, headers: {}, body: null };
      }
      const mppx = getMppxForChannel(registered);
      const humanAmount = fromBaseUnits(BigInt(offer.amount), decimals);
      const webRequest = new Request(request.url, { method: request.method });
      const channelMethod = (mppx as unknown as Record<string, (req: unknown) => (r: Request) => Promise<Response>>)[
        "stellar/channel"
      ];
      if (!channelMethod) {
        return { status: 402, headers: {}, body: null };
      }
      const result = await channelMethod({
        amount: humanAmount,
        channel: registered.channelId,
      })(webRequest);
      const headers: Record<string, string> = {};
      result.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        status: result.status,
        headers,
        body: result.body ? await result.text() : null,
      };
    },

    async verify({ payment, offer }) {
      const shapeError = validateVoucherShape(payment);
      if (shapeError) {
        return { valid: false, reason: shapeError };
      }
      if (offer.network !== options.network || offer.asset !== options.currency || offer.payTo !== options.recipient) {
        return { valid: false, reason: "offer does not match mpp-channel handler configuration" };
      }

      const registered = await options.registry.get(payment.channelId);
      if (!registered) {
        return { valid: false, reason: `channel-not-found: channel ${payment.channelId} is not registered` };
      }

      // Idempotent replay before touching @stellar/mpp (which rejects reused challenge IDs).
      const existingAtSeq = await options.voucherStore.getBySequence(payment.channelId, payment.sequence);
      if (existingAtSeq) {
        if (
          existingAtSeq.cumulativeAmount === payment.cumulativeAmount &&
          existingAtSeq.commitment === payment.commitment
        ) {
          return {
            valid: true,
            payer: existingAtSeq.payer,
            nonce: channelNonce(payment.channelId, payment.sequence),
          };
        }
        return {
          valid: false,
          reason: `commitment-conflict: sequence ${payment.sequence} already accepted with a different commitment`,
        };
      }

      const latest = await options.voucherStore.getLatest(payment.channelId);
      if (latest) {
        if (payment.sequence <= latest.sequence) {
          return {
            valid: false,
            reason: `stale sequence ${payment.sequence}; latest accepted is ${latest.sequence}`,
          };
        }
        if (BigInt(payment.cumulativeAmount) <= BigInt(latest.cumulativeAmount)) {
          return {
            valid: false,
            reason: `non-monotonic cumulativeAmount ${payment.cumulativeAmount} <= ${latest.cumulativeAmount}`,
          };
        }
      }

      const previousAmount = BigInt(latest?.cumulativeAmount ?? "0");
      if (BigInt(payment.cumulativeAmount) - previousAmount < BigInt(offer.amount)) {
        return {
          valid: false,
          reason: "voucher increment does not cover offer amount",
        };
      }

      const state = await readChannelState({
        channel: payment.channelId,
        network: offer.network,
        rpcUrl: options.rpcUrl,
      });
      if (state.closeEffectiveAtLedger !== null) {
        return { valid: false, reason: "channel is closing or closed on chain" };
      }
      if (state.token !== offer.asset || state.to !== offer.payTo) {
        return { valid: false, reason: "on-chain channel token or recipient mismatch" };
      }
      if (BigInt(state.balance) < BigInt(payment.cumulativeAmount)) {
        return { valid: false, reason: "on-chain channel balance is below cumulativeAmount" };
      }

      if (payment.credential) {
        try {
          const mppx = getMppxForChannel(registered);
          const credential = Credential.deserialize(payment.credential);
          const humanAmount = fromBaseUnits(BigInt(offer.amount), decimals);
          await (mppx as unknown as {
            verifyCredential: (c: unknown, opts: unknown) => Promise<unknown>;
          }).verifyCredential(credential, {
            amount: humanAmount,
            channel: registered.channelId,
          });
        } catch (error) {
          if (error instanceof StellarMppError || error instanceof Errors.PaymentError) {
            return { valid: false, reason: error.message };
          }
          return {
            valid: false,
            reason: error instanceof Error ? error.message : "mpp-channel credential verification failed",
          };
        }
      }

      return {
        valid: true,
        payer: registered.payer,
        nonce: channelNonce(payment.channelId, payment.sequence),
      };
    },

    async settle({ payment, payer }) {
      const existingAtSeq = await options.voucherStore.getBySequence(payment.channelId, payment.sequence);
      if (!existingAtSeq) {
        await options.voucherStore.record({
          channelId: payment.channelId,
          sequence: payment.sequence,
          cumulativeAmount: payment.cumulativeAmount,
          commitment: payment.commitment,
          payer,
          acceptedAt: now(),
        });
      }

      let txHash: string | undefined;
      if (payment.action === "close" && options.onCloseCredential) {
        const closed = await options.onCloseCredential({
          channelId: payment.channelId,
          sequence: payment.sequence,
          cumulativeAmount: payment.cumulativeAmount,
          commitment: payment.commitment,
          payer,
        });
        txHash = closed.txHash;
      }

      return {
        settled: true,
        settlement: {
          kind: "channel-commitment",
          channelId: payment.channelId,
          sequence: payment.sequence,
        },
        ...(txHash ? { txHash } : {}),
      };
    },
  };
}
