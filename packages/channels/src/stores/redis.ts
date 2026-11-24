/**
 * A `CommitmentStore` on Redis (#178). Each conditional write is one Lua
 * script, so its check and its write run atomically on the server. Two
 * processes sharing the Redis cannot both advance a channel. See
 * docs/channel-commitment-stores.md for setup and failure modes.
 *
 * Keys. A channel's record is a hash, and its commitment stream is a sorted
 * set scored by sequence. Both keys carry the channel id in a hash tag
 * (`tollway:ch:{<id>}:...`), so one script touches one slot and works on Redis
 * Cluster. A set of channel ids backs the listing queries. It is written in
 * a separate command, so it is not part of a script's atomicity.
 *
 * No key has a TTL. A channel record that expired would lose the latest
 * commitment, and with it the ability to close with the right amount.
 *
 * Amounts are passed to Lua as strings and stored as strings. Lua 5.1 numbers
 * are doubles and would lose precision above 2^53, so no amount is ever a Lua
 * number.
 */

import { createHash } from "node:crypto";
import { type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import { ChannelNotFoundError, CommitmentConflictError } from "../errors.js";
import type { CommitmentAppendExpectation, CommitmentStore } from "../store.js";
import { pageChannels } from "../store-query.js";
import type {
  Channel,
  ChannelListFilter,
  ChannelPage,
  ChannelStatus,
  Commitment,
} from "../types.js";

/**
 * The part of an ioredis client the store uses. ioredis satisfies it, so the
 * package has no runtime dependency on a Redis driver.
 */
export interface RedisLikeClient {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

export type RedisCommitmentStoreOptions = {
  client: RedisLikeClient;
  /** Prefix for every key this store writes. Defaults to `tollway:ch`. */
  keyPrefix?: string;
};

const CHANNEL_STATUSES: readonly ChannelStatus[] = [
  "open",
  "closing",
  "closed",
  "recovering",
  "recovered",
  "settlement-mismatched",
];
const NETWORKS: readonly StellarNetwork[] = ["testnet", "mainnet"];
const AMOUNT_RE = /^[0-9]+$/;
const INTEGER_RE = /^-?[0-9]+$/;

/**
 * Replaces the record hash. KEYS[1] is the record. ARGV holds field and value
 * pairs. Old fields are deleted first, so none survives from an earlier write.
 */
const PUT_SCRIPT = [
  "redis.call('DEL', KEYS[1])",
  "for i = 1, #ARGV, 2 do",
  "  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])",
  "end",
  "return {'ok'}",
].join("\n");

/**
 * Applies a patch, optionally conditioned on the status. KEYS[1] is the record.
 * ARGV[1] is the expected status, or '' to skip the check. ARGV[2] is how many
 * fields to delete, followed by those names. The rest are field and value
 * pairs to set. The reply carries the record after the write.
 */
const PATCH_SCRIPT = [
  "if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end",
  "if ARGV[1] ~= '' then",
  "  local status = redis.call('HGET', KEYS[1], 'status')",
  "  if status ~= ARGV[1] then return {'status', status} end",
  "end",
  "local deletes = tonumber(ARGV[2])",
  "for i = 3, deletes + 2 do redis.call('HDEL', KEYS[1], ARGV[i]) end",
  "for i = deletes + 3, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end",
  "local out = {'ok'}",
  "for _, v in ipairs(redis.call('HGETALL', KEYS[1])) do table.insert(out, v) end",
  "return out",
].join("\n");

/**
 * The compare-and-set append. KEYS[1] is the record, KEYS[2] the commitment
 * sorted set. ARGV: 1 expected status, 2 expected sequence, 3 the commitment's
 * sequence, 4 expected next sequence, 5 cumulative amount, 6 lastCommitAt,
 * 7 the commitment as a JSON member.
 *
 * The checks run in the same order as the memory store: status, then the
 * channel's sequence, then whether the commitment follows it. Only then does
 * the script write, so a conflict writes nothing.
 */
const APPEND_SCRIPT = [
  "if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end",
  "local status = redis.call('HGET', KEYS[1], 'status')",
  "if status ~= ARGV[1] then return {'status', status} end",
  "local sequence = redis.call('HGET', KEYS[1], 'sequence')",
  "if sequence ~= ARGV[2] then return {'sequence', sequence} end",
  "if ARGV[3] ~= ARGV[4] then return {'next'} end",
  "redis.call('HSET', KEYS[1], 'committed', ARGV[5], 'sequence', ARGV[3], 'lastCommitAt', ARGV[6])",
  "redis.call('ZADD', KEYS[2], ARGV[3], ARGV[7])",
  "local out = {'ok'}",
  "for _, v in ipairs(redis.call('HGETALL', KEYS[1])) do table.insert(out, v) end",
  "return out",
].join("\n");

function corrupt(detail: string): TollwayError {
  return new TollwayError("corrupt-channel-record", `Redis channel data is not valid: ${detail}`);
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("NOSCRIPT");
}

/**
 * Runs a script by SHA. If Redis has not loaded it yet (NOSCRIPT), the script
 * is sent with EVAL, which also loads it. Any other error is rethrown.
 */
async function runScript(
  client: RedisLikeClient,
  script: string,
  keys: readonly string[],
  args: readonly string[],
): Promise<string[]> {
  const sha = createHash("sha1").update(script).digest("hex");
  let reply: unknown;
  try {
    reply = await client.evalsha(sha, keys.length, ...keys, ...args);
  } catch (error) {
    if (!isNoScript(error)) throw error;
    reply = await client.eval(script, keys.length, ...keys, ...args);
  }
  if (!Array.isArray(reply) || !reply.every((item): item is string => typeof item === "string")) {
    throw corrupt("a script returned a reply that is not a list of strings");
  }
  return reply;
}

/** Turns a flat field, value, field, value list into a record. */
function pairsToHash(flat: readonly string[]): Record<string, string> {
  const hash: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const field = flat[i];
    const value = flat[i + 1];
    if (field === undefined || value === undefined) throw corrupt("an odd number of fields");
    hash[field] = value;
  }
  return hash;
}

function textField(hash: Readonly<Record<string, string>>, field: string): string {
  const value = hash[field];
  if (value === undefined) throw corrupt(`${field} is missing`);
  return value;
}

function optionalField(hash: Readonly<Record<string, string>>, field: string): string | undefined {
  return hash[field];
}

function amountField(hash: Readonly<Record<string, string>>, field: string): string {
  const value = textField(hash, field);
  if (!AMOUNT_RE.test(value)) throw corrupt(`${field} is not an integer amount`);
  return value;
}

function optionalAmountField(
  hash: Readonly<Record<string, string>>,
  field: string,
): string | undefined {
  const value = optionalField(hash, field);
  if (value !== undefined && !AMOUNT_RE.test(value)) {
    throw corrupt(`${field} is not an integer amount`);
  }
  return value;
}

function integerValue(value: string, field: string): number {
  if (!INTEGER_RE.test(value)) throw corrupt(`${field} is not an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw corrupt(`${field} is outside the safe integer range`);
  return parsed;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw corrupt(`${field} is "${value}", which is not allowed`);
  }
  return value as T;
}

/** Builds a Channel from a record hash. Optional fields are left out, not set to undefined. */
function hashToChannel(hash: Readonly<Record<string, string>>): Channel {
  const channel: Channel = {
    id: textField(hash, "id"),
    counterparty: textField(hash, "counterparty"),
    asset: textField(hash, "asset"),
    deposit: amountField(hash, "deposit"),
    committed: amountField(hash, "committed"),
    sequence: integerValue(textField(hash, "sequence"), "sequence"),
    status: oneOf(textField(hash, "status"), CHANNEL_STATUSES, "status"),
    network: oneOf(textField(hash, "network"), NETWORKS, "network"),
    openTxHash: textField(hash, "openTxHash"),
    openedAt: textField(hash, "openedAt"),
  };
  const lastCommitAt = optionalField(hash, "lastCommitAt");
  if (lastCommitAt !== undefined) channel.lastCommitAt = lastCommitAt;
  const settlementTxHash = optionalField(hash, "settlementTxHash");
  if (settlementTxHash !== undefined) channel.settlementTxHash = settlementTxHash;
  const returnedRemainder = optionalAmountField(hash, "returnedRemainder");
  if (returnedRemainder !== undefined) channel.returnedRemainder = returnedRemainder;

  const attemptId = optionalField(hash, "closeAttemptId");
  const attemptLedger = optionalField(hash, "closeAttemptLedger");
  const attemptStartedAt = optionalField(hash, "closeAttemptStartedAt");
  if (attemptId !== undefined || attemptLedger !== undefined || attemptStartedAt !== undefined) {
    if (attemptId === undefined || attemptLedger === undefined || attemptStartedAt === undefined) {
      throw corrupt("the close attempt is only partly set");
    }
    channel.closeAttempt = {
      attemptId,
      startedAtLedger: integerValue(attemptLedger, "closeAttemptLedger"),
      startedAt: attemptStartedAt,
    };
  }

  const expected = optionalAmountField(hash, "settlementExpectedAmount");
  const observed = optionalAmountField(hash, "settlementObservedAmount");
  if (expected !== undefined || observed !== undefined) {
    if (expected === undefined || observed === undefined) {
      throw corrupt("the settlement mismatch is only partly set");
    }
    channel.settlementMismatch = { expectedAmount: expected, observedAmount: observed };
  }
  return channel;
}

/** Field changes for a patch. A key that is present with no value deletes its field. */
type FieldPatch = { deletes: string[]; sets: Array<[string, string]> };

function patchFields(patch: Partial<Channel>): FieldPatch {
  const deletes: string[] = [];
  const sets: Array<[string, string]> = [];
  const put = (field: string, value: string | number | null | undefined): void => {
    if (value === undefined || value === null) deletes.push(field);
    else sets.push([field, String(value)]);
  };
  if ("counterparty" in patch) put("counterparty", patch.counterparty);
  if ("asset" in patch) put("asset", patch.asset);
  if ("deposit" in patch) put("deposit", patch.deposit);
  if ("committed" in patch) put("committed", patch.committed);
  if ("sequence" in patch) put("sequence", patch.sequence);
  if ("status" in patch) put("status", patch.status);
  if ("network" in patch) put("network", patch.network);
  if ("openTxHash" in patch) put("openTxHash", patch.openTxHash);
  if ("openedAt" in patch) put("openedAt", patch.openedAt);
  if ("lastCommitAt" in patch) put("lastCommitAt", patch.lastCommitAt);
  if ("settlementTxHash" in patch) put("settlementTxHash", patch.settlementTxHash);
  if ("returnedRemainder" in patch) put("returnedRemainder", patch.returnedRemainder);
  if ("closeAttempt" in patch) {
    put("closeAttemptId", patch.closeAttempt?.attemptId);
    put("closeAttemptLedger", patch.closeAttempt?.startedAtLedger);
    put("closeAttemptStartedAt", patch.closeAttempt?.startedAt);
  }
  if ("settlementMismatch" in patch) {
    put("settlementExpectedAmount", patch.settlementMismatch?.expectedAmount);
    put("settlementObservedAmount", patch.settlementMismatch?.observedAmount);
  }
  return { deletes, sets };
}

/** The argument list for PATCH_SCRIPT. */
function patchArgs(expectedStatus: string, changes: FieldPatch): string[] {
  return [
    expectedStatus,
    String(changes.deletes.length),
    ...changes.deletes,
    ...changes.sets.flat(),
  ];
}

/** Checks a commitment read back from the sorted set before it is used. */
function memberToCommitment(member: string): Commitment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(member);
  } catch (cause) {
    throw new TollwayError("corrupt-channel-record", "a commitment entry is not JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null) throw corrupt("a commitment is not an object");
  const record = parsed as Record<string, unknown>;
  const channelId = record.channelId;
  const sequence = record.sequence;
  const cumulativeAmount = record.cumulativeAmount;
  const blob = record.commitment;
  if (
    typeof channelId !== "string" ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    typeof cumulativeAmount !== "string" ||
    !AMOUNT_RE.test(cumulativeAmount) ||
    typeof blob !== "string"
  ) {
    throw corrupt("a commitment entry has a missing or malformed field");
  }
  return { channelId, sequence, cumulativeAmount, commitment: blob };
}

/** Channel ids go into a hash tag, so they cannot hold braces. */
function assertChannelId(channelId: string): void {
  if (channelId.length === 0 || /[{}]/.test(channelId)) {
    throw new TollwayError(
      "invalid-store-config",
      `channel id "${channelId}" must not be empty or contain braces (Redis hash tags)`,
    );
  }
}

/**
 * Creates a `CommitmentStore` on Redis. Keys carry the channel id in a hash tag,
 * so each script touches one slot. See the module comment for the design.
 */
export function createRedisCommitmentStore(options: RedisCommitmentStoreOptions): CommitmentStore {
  const { client } = options;
  const prefix = options.keyPrefix ?? "tollway:ch";
  const recordKey = (channelId: string): string => `${prefix}:{${channelId}}:record`;
  const commitmentsKey = (channelId: string): string => `${prefix}:{${channelId}}:commitments`;
  const indexKey = `${prefix}:index`;

  async function readChannel(channelId: string): Promise<Channel | undefined> {
    const hash = await client.hgetall(recordKey(channelId));
    if (Object.keys(hash).length === 0) return undefined;
    return hashToChannel(hash);
  }

  /** Every indexed channel whose record still exists. */
  async function allChannels(): Promise<Channel[]> {
    const ids = await client.smembers(indexKey);
    const channels = await Promise.all(ids.map((id) => readChannel(id)));
    return channels.flatMap((channel) => (channel === undefined ? [] : [channel]));
  }

  return {
    async putChannel(channel) {
      assertChannelId(channel.id);
      // The index is written first. A crash between the two writes leaves an
      // id with no record, which the listings skip. The reverse would hide a
      // channel that is tracked.
      await client.sadd(indexKey, channel.id);
      const changes = patchFields({ ...channel });
      const sets: string[] = ["id", channel.id, ...changes.sets.flat()];
      await runScript(client, PUT_SCRIPT, [recordKey(channel.id)], sets);
    },

    async getChannel(channelId) {
      assertChannelId(channelId);
      return readChannel(channelId);
    },

    async updateChannel(channelId, patch) {
      assertChannelId(channelId);
      const reply = await runScript(
        client,
        PATCH_SCRIPT,
        [recordKey(channelId)],
        patchArgs("", patchFields(patch)),
      );
      if (reply[0] === "missing") return undefined;
      return hashToChannel(pairsToHash(reply.slice(1)));
    },

    async appendCommitment(commitment, expectation: CommitmentAppendExpectation) {
      assertChannelId(commitment.channelId);
      const expectedNext = expectation.expectedSequence + 1;
      const member = JSON.stringify(commitment);
      const reply = await runScript(
        client,
        APPEND_SCRIPT,
        [recordKey(commitment.channelId), commitmentsKey(commitment.channelId)],
        [
          expectation.expectedStatus,
          String(expectation.expectedSequence),
          String(commitment.sequence),
          String(expectedNext),
          commitment.cumulativeAmount,
          expectation.lastCommitAt,
          member,
        ],
      );
      const [outcome, detail] = reply;
      switch (outcome) {
        case "missing":
          throw new ChannelNotFoundError(commitment.channelId);
        case "status":
          throw new CommitmentConflictError(
            commitment.channelId,
            "status",
            expectation.expectedStatus,
            detail ?? "",
          );
        case "sequence":
          throw new CommitmentConflictError(
            commitment.channelId,
            "sequence",
            String(expectation.expectedSequence),
            detail ?? "",
          );
        case "next":
          throw new CommitmentConflictError(
            commitment.channelId,
            "sequence",
            String(expectedNext),
            String(commitment.sequence),
          );
        case "ok":
          return hashToChannel(pairsToHash(reply.slice(1)));
        default:
          throw corrupt(`the append script returned "${String(outcome)}"`);
      }
    },

    async transitionChannel(channelId, expectedStatus, patch) {
      assertChannelId(channelId);
      const reply = await runScript(
        client,
        PATCH_SCRIPT,
        [recordKey(channelId)],
        patchArgs(expectedStatus, patchFields(patch)),
      );
      if (reply[0] === "missing") throw new ChannelNotFoundError(channelId);
      if (reply[0] === "status") {
        throw new CommitmentConflictError(channelId, "status", expectedStatus, reply[1] ?? "");
      }
      return hashToChannel(pairsToHash(reply.slice(1)));
    },

    async listCommitments(channelId) {
      assertChannelId(channelId);
      const members = await client.zrange(commitmentsKey(channelId), 0, -1);
      return members.map(memberToCommitment);
    },

    async listChannelsByStatus(status) {
      return (await allChannels()).filter((channel) => channel.status === status);
    },

    async listChannels(filter: ChannelListFilter = {}): Promise<ChannelPage> {
      // Reads every indexed channel. Fine for the sizes this store targets;
      // a status index is the next step if that changes (see the docs page).
      return pageChannels(await allChannels(), filter);
    },
  };
}
