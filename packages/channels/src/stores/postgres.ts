/**
 * A `CommitmentStore` on PostgreSQL (#177), so channel state survives a
 * restart and can be shared by several processes. Apply
 * `packages/channels/migrations/0001_commitment_store.sql` first.
 *
 * The store takes a structural client, so `@vegaforge/tollway-channels` has no
 * runtime dependency on a driver. A `pg` Pool fits it, because a Pool has
 * `query` and `connect`. A single PoolClient also fits, and runs the work on
 * that one connection.
 *
 * Compare-and-set is a conditional UPDATE, not a read followed by a write. An
 * append runs in one transaction with the commitment INSERT, and the primary
 * key on `(channel_id, sequence)` backs it up. The isolation level is READ
 * COMMITTED: a racing UPDATE waits on the row lock, then re-checks its WHERE
 * clause against the new row, so exactly one of two racing appends matches.
 * See docs/channel-commitment-stores.md.
 */

import { type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import { ChannelNotFoundError, CommitmentConflictError } from "../errors.js";
import type { CommitmentAppendExpectation, CommitmentStore } from "../store.js";
import { decodeChannelCursor, parseChannelPageLimit, toChannelPage } from "../store-query.js";
import type {
  Channel,
  ChannelListFilter,
  ChannelPage,
  ChannelStatus,
  Commitment,
} from "../types.js";

/** One row, as the driver returns it. Values are checked before use. */
type Row = Readonly<Record<string, unknown>>;

export type PostgresQueryResult = {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
};

/** The part of a pg Pool or PoolClient the store uses. */
export interface PostgresQueryable {
  query(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult>;
}

/** A connection checked out of a pool. `release(true)` destroys it instead of reusing it. */
export interface PostgresConnection extends PostgresQueryable {
  release(destroy?: boolean): void;
}

/** A pg Pool, or a single connection. A Pool has `connect`; a connection does not. */
export interface PostgresClient extends PostgresQueryable {
  connect?(): Promise<PostgresConnection>;
}

export type PostgresCommitmentStoreOptions = {
  client: PostgresClient;
  /**
   * The schema that holds the tables from migration 0001. Omit it to use the
   * connection's search_path. Must be a plain identifier.
   */
  schema?: string;
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
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const UNIQUE_VIOLATION = "23505";

/** Every channel column, with amounts cast to text so they read back exact. */
const CHANNEL_SELECT = [
  "id",
  "counterparty",
  "asset",
  "deposit::text AS deposit",
  "committed::text AS committed",
  "sequence",
  "status",
  "network",
  "open_tx_hash",
  "opened_at",
  "last_commit_at",
  "settlement_tx_hash",
  "returned_remainder::text AS returned_remainder",
  "close_attempt_id",
  "close_attempt_ledger",
  "close_attempt_started_at",
  "settlement_expected_amount::text AS settlement_expected_amount",
  "settlement_observed_amount::text AS settlement_observed_amount",
].join(", ");

type Assignment = { column: string; value: unknown };

/**
 * Column assignments for the keys present in a patch. A key present with an
 * undefined value writes NULL, as the memory store's spread does.
 */
function patchAssignments(patch: Partial<Channel>): Assignment[] {
  const out: Assignment[] = [];
  const set = (column: string, value: unknown): void => {
    out.push({ column, value });
  };
  if ("counterparty" in patch) set("counterparty", patch.counterparty);
  if ("asset" in patch) set("asset", patch.asset);
  if ("deposit" in patch) set("deposit", patch.deposit);
  if ("committed" in patch) set("committed", patch.committed);
  if ("sequence" in patch) set("sequence", patch.sequence);
  if ("status" in patch) set("status", patch.status);
  if ("network" in patch) set("network", patch.network);
  if ("openTxHash" in patch) set("open_tx_hash", patch.openTxHash);
  if ("openedAt" in patch) set("opened_at", patch.openedAt);
  if ("lastCommitAt" in patch) set("last_commit_at", patch.lastCommitAt ?? null);
  if ("settlementTxHash" in patch) set("settlement_tx_hash", patch.settlementTxHash ?? null);
  if ("returnedRemainder" in patch) set("returned_remainder", patch.returnedRemainder ?? null);
  if ("closeAttempt" in patch) {
    set("close_attempt_id", patch.closeAttempt?.attemptId ?? null);
    set("close_attempt_ledger", patch.closeAttempt?.startedAtLedger ?? null);
    set("close_attempt_started_at", patch.closeAttempt?.startedAt ?? null);
  }
  if ("settlementMismatch" in patch) {
    set("settlement_expected_amount", patch.settlementMismatch?.expectedAmount ?? null);
    set("settlement_observed_amount", patch.settlementMismatch?.observedAmount ?? null);
  }
  return out;
}

/** `col = $first, col = $next, ...` for a parameter list. */
function setList(assignments: readonly Assignment[], firstParam: number): string {
  return assignments.map((a, i) => `${a.column} = $${firstParam + i}`).join(", ");
}

function corrupt(detail: string): TollwayError {
  return new TollwayError("corrupt-channel-record", `channel row is not valid: ${detail}`);
}

function textOf(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw corrupt(`${key} is not text`);
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw corrupt(`${key} is not text`);
  return value;
}

function amountOf(row: Row, key: string): string {
  const value = textOf(row, key);
  if (!AMOUNT_RE.test(value)) throw corrupt(`${key} is not an integer amount`);
  return value;
}

function optionalAmount(row: Row, key: string): string | undefined {
  const value = optionalText(row, key);
  if (value !== undefined && !AMOUNT_RE.test(value)) {
    throw corrupt(`${key} is not an integer amount`);
  }
  return value;
}

function integerOf(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw corrupt(`${key} is not an integer`);
  }
  return value;
}

function optionalInteger(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw corrupt(`${key} is not an integer`);
  }
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw corrupt(`${key} is "${value}", which is not allowed`);
  }
  return value as T;
}

/** Builds a Channel from a row. Optional fields are left out, not set to undefined. */
function rowToChannel(row: Row): Channel {
  const channel: Channel = {
    id: textOf(row, "id"),
    counterparty: textOf(row, "counterparty"),
    asset: textOf(row, "asset"),
    deposit: amountOf(row, "deposit"),
    committed: amountOf(row, "committed"),
    sequence: integerOf(row, "sequence"),
    status: oneOf(textOf(row, "status"), CHANNEL_STATUSES, "status"),
    network: oneOf(textOf(row, "network"), NETWORKS, "network"),
    openTxHash: textOf(row, "open_tx_hash"),
    openedAt: textOf(row, "opened_at"),
  };
  const lastCommitAt = optionalText(row, "last_commit_at");
  if (lastCommitAt !== undefined) channel.lastCommitAt = lastCommitAt;
  const settlementTxHash = optionalText(row, "settlement_tx_hash");
  if (settlementTxHash !== undefined) channel.settlementTxHash = settlementTxHash;
  const returnedRemainder = optionalAmount(row, "returned_remainder");
  if (returnedRemainder !== undefined) channel.returnedRemainder = returnedRemainder;

  const attemptId = optionalText(row, "close_attempt_id");
  const attemptLedger = optionalInteger(row, "close_attempt_ledger");
  const attemptStartedAt = optionalText(row, "close_attempt_started_at");
  if (attemptId !== undefined || attemptLedger !== undefined || attemptStartedAt !== undefined) {
    if (attemptId === undefined || attemptLedger === undefined || attemptStartedAt === undefined) {
      throw corrupt("the close attempt is only partly set");
    }
    channel.closeAttempt = {
      attemptId,
      startedAtLedger: attemptLedger,
      startedAt: attemptStartedAt,
    };
  }

  const expected = optionalAmount(row, "settlement_expected_amount");
  const observed = optionalAmount(row, "settlement_observed_amount");
  if (expected !== undefined || observed !== undefined) {
    if (expected === undefined || observed === undefined) {
      throw corrupt("the settlement mismatch is only partly set");
    }
    channel.settlementMismatch = { expectedAmount: expected, observedAmount: observed };
  }
  return channel;
}

function rowToCommitment(row: Row): Commitment {
  return {
    channelId: textOf(row, "channel_id"),
    sequence: integerOf(row, "sequence"),
    cumulativeAmount: amountOf(row, "cumulative_amount"),
    commitment: textOf(row, "commitment"),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === UNIQUE_VIOLATION;
}

/**
 * Runs `work` in one transaction. A pool is checked out for the work and
 * released after. If the rollback itself fails, the connection is destroyed
 * rather than returned to the pool, and the original error is still thrown.
 */
async function transaction<T>(
  client: PostgresClient,
  work: (tx: PostgresQueryable) => Promise<T>,
): Promise<T> {
  const connection = client.connect === undefined ? undefined : await client.connect();
  const tx: PostgresQueryable = connection ?? client;
  let broken = false;
  try {
    try {
      await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const value = await work(tx);
      await tx.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await tx.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    }
  } finally {
    connection?.release(broken);
  }
}

/** The names a store reads and writes, qualified with the schema when one is given. */
function tableNames(schema: string | undefined): { channels: string; commitments: string } {
  if (schema === undefined) return { channels: "channels", commitments: "commitments" };
  if (!SCHEMA_RE.test(schema)) {
    throw new TollwayError(
      "invalid-store-config",
      `schema "${schema}" is not a plain identifier (letters, digits and underscores)`,
    );
  }
  return { channels: `"${schema}".channels`, commitments: `"${schema}".commitments` };
}

/**
 * Creates a `CommitmentStore` on PostgreSQL. See the module comment for the
 * compare-and-set design and docs/channel-commitment-stores.md for setup.
 */
export function createPostgresCommitmentStore(
  options: PostgresCommitmentStoreOptions,
): CommitmentStore {
  const { client } = options;
  const names = tableNames(options.schema);

  async function fetchChannel(channelId: string): Promise<Channel | undefined> {
    const result = await client.query(
      `SELECT ${CHANNEL_SELECT} FROM ${names.channels} WHERE id = $1`,
      [channelId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToChannel(row);
  }

  /** Names why a conditional append matched no row. Status is checked first. */
  async function appendFailure(
    tx: PostgresQueryable,
    channelId: string,
    expectation: CommitmentAppendExpectation,
  ): Promise<Error> {
    const result = await tx.query(`SELECT status, sequence FROM ${names.channels} WHERE id = $1`, [
      channelId,
    ]);
    const row = result.rows[0];
    if (row === undefined) return new ChannelNotFoundError(channelId);
    const status = oneOf(textOf(row, "status"), CHANNEL_STATUSES, "status");
    if (status !== expectation.expectedStatus) {
      return new CommitmentConflictError(channelId, "status", expectation.expectedStatus, status);
    }
    return new CommitmentConflictError(
      channelId,
      "sequence",
      String(expectation.expectedSequence),
      String(integerOf(row, "sequence")),
    );
  }

  return {
    async putChannel(channel) {
      // Every optional column is written, so a record put over an older one
      // does not keep a stale value.
      const full: Partial<Channel> = {
        lastCommitAt: undefined,
        settlementTxHash: undefined,
        returnedRemainder: undefined,
        closeAttempt: undefined,
        settlementMismatch: undefined,
        ...channel,
      };
      const assignments = patchAssignments(full);
      const columns = ["id", ...assignments.map((a) => a.column)];
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const updates = assignments.map((a) => `${a.column} = EXCLUDED.${a.column}`);
      const insert = `INSERT INTO ${names.channels} (${columns.join(", ")})`;
      const values = `VALUES (${placeholders.join(", ")})`;
      await client.query(
        `${insert} ${values} ON CONFLICT (id) DO UPDATE SET ${updates.join(", ")}`,
        [channel.id, ...assignments.map((a) => a.value)],
      );
    },

    async getChannel(channelId) {
      return fetchChannel(channelId);
    },

    async updateChannel(channelId, patch) {
      const assignments = patchAssignments(patch);
      if (assignments.length === 0) return fetchChannel(channelId);
      const result = await client.query(
        `UPDATE ${names.channels} SET ${setList(assignments, 2)} WHERE id = $1 ` +
          `RETURNING ${CHANNEL_SELECT}`,
        [channelId, ...assignments.map((a) => a.value)],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : rowToChannel(row);
    },

    async appendCommitment(commitment, expectation) {
      const expectedNext = expectation.expectedSequence + 1;
      return transaction(client, async (tx) => {
        // The compare-and-set. It matches only if the channel still has the
        // expected status and sequence, and the row lock makes a racing
        // append wait, then fail this match.
        const result = await tx.query(
          `UPDATE ${names.channels} SET committed = $3, sequence = $4, last_commit_at = $5 ` +
            `WHERE id = $1 AND sequence = $2 AND status = $6 RETURNING ${CHANNEL_SELECT}`,
          [
            commitment.channelId,
            expectation.expectedSequence,
            commitment.cumulativeAmount,
            commitment.sequence,
            expectation.lastCommitAt,
            expectation.expectedStatus,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw await appendFailure(tx, commitment.channelId, expectation);
        }
        // The UPDATE above already wrote the new sequence. A commitment that
        // does not follow the expected one throws here, so the rollback undoes it.
        if (commitment.sequence !== expectedNext) {
          throw new CommitmentConflictError(
            commitment.channelId,
            "sequence",
            String(expectedNext),
            String(commitment.sequence),
          );
        }
        try {
          await tx.query(
            `INSERT INTO ${names.commitments} ` +
              "(channel_id, sequence, cumulative_amount, commitment) VALUES ($1, $2, $3, $4)",
            [
              commitment.channelId,
              commitment.sequence,
              commitment.cumulativeAmount,
              commitment.commitment,
            ],
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new CommitmentConflictError(
              commitment.channelId,
              "sequence",
              String(expectedNext),
              String(commitment.sequence),
            );
          }
          throw error;
        }
        return rowToChannel(row);
      });
    },

    async transitionChannel(channelId, expectedStatus, patch) {
      const assignments = patchAssignments(patch);
      // A transition with no fields still checks the status. `id = id` is a no-op assignment.
      const setSql = assignments.length > 0 ? setList(assignments, 3) : "id = id";
      const result = await client.query(
        `UPDATE ${names.channels} SET ${setSql} WHERE id = $1 AND status = $2 ` +
          `RETURNING ${CHANNEL_SELECT}`,
        [channelId, expectedStatus, ...assignments.map((a) => a.value)],
      );
      const row = result.rows[0];
      if (row !== undefined) return rowToChannel(row);

      const current = await client.query(`SELECT status FROM ${names.channels} WHERE id = $1`, [
        channelId,
      ]);
      const found = current.rows[0];
      if (found === undefined) throw new ChannelNotFoundError(channelId);
      throw new CommitmentConflictError(
        channelId,
        "status",
        expectedStatus,
        oneOf(textOf(found, "status"), CHANNEL_STATUSES, "status"),
      );
    },

    async listCommitments(channelId) {
      const result = await client.query(
        "SELECT channel_id, sequence, cumulative_amount::text AS cumulative_amount, commitment " +
          `FROM ${names.commitments} WHERE channel_id = $1 ORDER BY sequence`,
        [channelId],
      );
      return result.rows.map(rowToCommitment);
    },

    async listChannelsByStatus(status) {
      const result = await client.query(
        `SELECT ${CHANNEL_SELECT} FROM ${names.channels} WHERE status = $1 ORDER BY id`,
        [status],
      );
      return result.rows.map(rowToChannel);
    },

    async listChannels(filter: ChannelListFilter = {}): Promise<ChannelPage> {
      // The same rules as every other store (store-query.ts): exact filters,
      // newest first by opened_at then id, keyset paging from the cursor.
      const limit = parseChannelPageLimit(filter.limit);
      const cursor = filter.cursor === undefined ? undefined : decodeChannelCursor(filter.cursor);
      const clauses: string[] = [];
      const params: unknown[] = [];
      const param = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      if (filter.status !== undefined) clauses.push(`status = ${param(filter.status)}`);
      if (filter.counterparty !== undefined) {
        clauses.push(`counterparty = ${param(filter.counterparty)}`);
      }
      if (filter.asset !== undefined) clauses.push(`asset = ${param(filter.asset)}`);
      if (filter.network !== undefined) clauses.push(`network = ${param(filter.network)}`);
      if (cursor !== undefined) {
        // Rows after the cursor in descending order. Both columns use
        // collation "C" (see the migration), the code-unit order the other
        // stores use.
        const openedAt = param(cursor.openedAt);
        const id = param(cursor.id);
        clauses.push(`(opened_at, id) < (${openedAt}, ${id})`);
      }
      // One extra row tells whether another page follows.
      const limitParam = param(limit + 1);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

      const result = await client.query(
        `SELECT ${CHANNEL_SELECT} FROM ${names.channels} ${where} ` +
          `ORDER BY opened_at DESC, id DESC LIMIT ${limitParam}`,
        params,
      );
      return toChannelPage(result.rows.map(rowToChannel), limit);
    },
  };
}
