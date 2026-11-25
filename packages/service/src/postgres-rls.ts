import { type TenantScope, tenantScopeSchema } from "./tenancy.js";

/**
 * Postgres multi-tenant DDL and transaction scoping (#231).
 *
 * Primary isolation is structural: `(org_id, project_id)` leads every primary
 * key, foreign key and secondary index, so caller-chosen receipt, channel and
 * agent ids cannot collide across projects.
 *
 * Row-level security (`ENABLE` + `FORCE ROW LEVEL SECURITY`) is the second
 * layer: every tenant transaction binds `tollway.org_id` and
 * `tollway.project_id` with `set_config(..., true)` (transaction-local), and
 * policies compare against `NULLIF(current_setting(..., true), '')`. A query
 * that forgets a `WHERE` clause or runs outside {@link withTenantTransaction}
 * matches zero rows and rejects writes instead of leaking across tenants. A
 * separate `FOR SELECT` policy gated on `tollway.operator_read = 'on'` lets
 * {@link withOperatorReadTransaction} compute per-tenant count rollups inside a
 * read-only transaction without needing `BYPASSRLS`.
 *
 * Limits: a database superuser, a role with `BYPASSRLS`, or anyone with host or
 * backup access sees every tenant's rows. See `apps/web/src/content/docs/service.mdx`.
 */

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new RangeError(
      `${label} must match ${SQL_IDENTIFIER.source}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Minimal query client satisfied by `pg`'s `Client` and `PoolClient`. */
export type PostgresQueryClient = {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** A checked-out pooled PostgreSQL connection; `release(true)` destroys a broken session. */
export type PostgresPoolClient = PostgresQueryClient & {
  release(destroy?: boolean): void;
};

/** A PostgreSQL connection pool that lends dedicated connections for transactions. */
export type PostgresPool = {
  connect(): Promise<PostgresPoolClient>;
};

/** Either a connection pool or an already-dedicated PostgreSQL client. */
export type PostgresSessionSource = PostgresPool | PostgresQueryClient;

/** Naming options for {@link serviceTenantMigrations}. */
export type ServicePostgresSchemaOptions = {
  /** Optional PostgreSQL schema name, for example `tollway`. */
  schema?: string;
  /** Prefix for table names. Defaults to `tollway_service_`. */
  tablePrefix?: string;
};

const TENANT_TABLES = [
  "receipts",
  "metrics",
  "channels",
  "commitments",
  "policy_versions",
  "audit_entries",
] as const;

function qualify(schema: string | undefined, name: string): string {
  return schema === undefined ? name : `${schema}.${name}`;
}

function rlsCondition(): string {
  return [
    "org_id = NULLIF(current_setting('tollway.org_id', true), '')",
    "AND project_id = NULLIF(current_setting('tollway.project_id', true), '')",
  ].join(" ");
}

/**
 * Returns idempotent SQL statements creating the multi-tenant service tables,
 * composite indexes and forced row-level security policies.
 */
export function serviceTenantMigrations(
  options: ServicePostgresSchemaOptions = {},
): readonly string[] {
  const schema =
    options.schema === undefined ? undefined : assertSqlIdentifier(options.schema, "schema");
  const prefix = assertSqlIdentifier(options.tablePrefix ?? "tollway_service_", "tablePrefix");
  const table = (suffix: string) => qualify(schema, `${prefix}${suffix}`);

  const receipts = table("receipts");
  const metrics = table("metrics");
  const channels = table("channels");
  const commitments = table("commitments");
  const policies = table("policy_versions");
  const audit = table("audit_entries");

  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS ${receipts} (
      org_id TEXT NOT NULL COLLATE "C",
      project_id TEXT NOT NULL COLLATE "C",
      id TEXT NOT NULL COLLATE "C",
      issued_at_ms BIGINT NOT NULL,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      model TEXT NOT NULL,
      network TEXT NOT NULL,
      asset TEXT NOT NULL,
      resource TEXT NOT NULL,
      tx_hash TEXT,
      channel_id TEXT,
      sequence INTEGER,
      canonical TEXT NOT NULL,
      PRIMARY KEY (org_id, project_id, id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}receipts_issued_idx ON ${receipts} (org_id, project_id, issued_at_ms DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}receipts_payer_idx ON ${receipts} (org_id, project_id, payer, issued_at_ms DESC)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}receipts_payee_idx ON ${receipts} (org_id, project_id, payee, issued_at_ms DESC)`,

    `CREATE TABLE IF NOT EXISTS ${metrics} (
      org_id TEXT NOT NULL COLLATE "C",
      project_id TEXT NOT NULL COLLATE "C",
      position BIGSERIAL NOT NULL,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      model TEXT NOT NULL,
      amount NUMERIC(78, 0) NOT NULL CHECK (amount >= 0),
      asset TEXT NOT NULL,
      latency_ms DOUBLE PRECISION NOT NULL CHECK (latency_ms >= 0),
      outcome TEXT NOT NULL,
      at TEXT NOT NULL,
      at_ms BIGINT NOT NULL,
      PRIMARY KEY (org_id, project_id, position)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}metrics_at_idx ON ${metrics} (org_id, project_id, at_ms)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}metrics_payer_idx ON ${metrics} (org_id, project_id, payer)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}metrics_payee_idx ON ${metrics} (org_id, project_id, payee)`,

    `CREATE TABLE IF NOT EXISTS ${channels} (
      org_id TEXT NOT NULL COLLATE "C",
      project_id TEXT NOT NULL COLLATE "C",
      id TEXT NOT NULL COLLATE "C",
      counterparty TEXT NOT NULL,
      asset TEXT NOT NULL,
      deposit NUMERIC(39, 0) NOT NULL CHECK (deposit >= 0),
      committed NUMERIC(39, 0) NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= -1),
      status TEXT NOT NULL CHECK (status IN (
        'open', 'closing', 'closed', 'recovering', 'recovered', 'settlement-mismatched'
      )),
      network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
      open_tx_hash TEXT NOT NULL,
      opened_at TEXT NOT NULL COLLATE "C",
      last_commit_at TEXT,
      settlement_tx_hash TEXT,
      returned_remainder NUMERIC(39, 0),
      close_attempt_id TEXT,
      close_attempt_ledger INTEGER,
      close_attempt_started_at TEXT,
      settlement_expected_amount NUMERIC(39, 0),
      settlement_observed_amount NUMERIC(39, 0),
      CHECK (committed >= 0 AND committed <= deposit),
      PRIMARY KEY (org_id, project_id, id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}channels_listing_idx ON ${channels} (org_id, project_id, opened_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}channels_status_idx ON ${channels} (org_id, project_id, status, opened_at DESC, id DESC)`,

    `CREATE TABLE IF NOT EXISTS ${commitments} (
      org_id TEXT NOT NULL COLLATE "C",
      project_id TEXT NOT NULL COLLATE "C",
      channel_id TEXT NOT NULL COLLATE "C",
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      cumulative_amount NUMERIC(39, 0) NOT NULL CHECK (cumulative_amount >= 0),
      commitment TEXT NOT NULL,
      PRIMARY KEY (org_id, project_id, channel_id, sequence),
      FOREIGN KEY (org_id, project_id, channel_id) REFERENCES ${channels} (org_id, project_id, id)
    )`,

    `CREATE TABLE IF NOT EXISTS ${policies} (
      org_id TEXT NOT NULL COLLATE "C",
      project_id TEXT NOT NULL COLLATE "C",
      agent_id TEXT NOT NULL COLLATE "C",
      version INTEGER NOT NULL CHECK (version >= 1),
      policy_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, project_id, agent_id, version)
    )`,

    `CREATE TABLE IF NOT EXISTS ${audit} (
      org_id TEXT NOT NULL COLLATE "C",
      project_id TEXT NOT NULL COLLATE "C",
      seq BIGSERIAL NOT NULL,
      id TEXT NOT NULL COLLATE "C",
      action TEXT NOT NULL,
      actor_key TEXT NOT NULL,
      agent_id TEXT,
      resource_id TEXT,
      version INTEGER,
      changes_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, project_id, seq),
      UNIQUE (org_id, project_id, id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${prefix}audit_agent_idx ON ${audit} (org_id, project_id, agent_id, seq DESC)`,
  ];

  const condition = rlsCondition();
  for (const suffix of TENANT_TABLES) {
    const qualified = table(suffix);
    const tenantPolicy = `${prefix}${suffix}_tenant_isolation`;
    const operatorPolicy = `${prefix}${suffix}_operator_read`;
    statements.push(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
    statements.push(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`);
    statements.push(`DROP POLICY IF EXISTS ${tenantPolicy} ON ${qualified}`);
    statements.push(
      `CREATE POLICY ${tenantPolicy} ON ${qualified} FOR ALL USING (${condition}) WITH CHECK (${condition})`,
    );
    statements.push(`DROP POLICY IF EXISTS ${operatorPolicy} ON ${qualified}`);
    statements.push(
      `CREATE POLICY ${operatorPolicy} ON ${qualified} FOR SELECT USING (current_setting('tollway.operator_read', true) = 'on')`,
    );
  }

  return statements;
}

function isPool(source: PostgresSessionSource): source is PostgresPool {
  return "connect" in source && typeof source.connect === "function";
}

async function runScopedTransaction<T>(
  source: PostgresSessionSource,
  beginSql: string,
  setupSql: string,
  setupParams: readonly unknown[] | undefined,
  work: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  const pooled = isPool(source) ? await source.connect() : undefined;
  const client: PostgresQueryClient = pooled ?? (source as PostgresQueryClient);
  let broken = false;

  try {
    try {
      await client.query(beginSql);
      await client.query(setupSql, setupParams);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    }
  } finally {
    pooled?.release(broken);
  }
}

/**
 * Runs `work` inside a single PostgreSQL transaction with `tollway.org_id` and
 * `tollway.project_id` bound locally (`set_config(..., true)`). If `ROLLBACK`
 * fails on a pooled connection, `release(true)` destroys the connection so
 * stale transaction state can never return to the pool.
 */
export async function withTenantTransaction<T>(
  source: PostgresSessionSource,
  tenant: TenantScope,
  work: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  const checked = tenantScopeSchema.parse(tenant);
  return runScopedTransaction(
    source,
    "BEGIN",
    "SELECT set_config('tollway.org_id', $1, true), set_config('tollway.project_id', $2, true)",
    [checked.orgId, checked.projectId],
    work,
  );
}

/**
 * Runs `work` inside a `READ ONLY` PostgreSQL transaction with
 * `tollway.operator_read = 'on'` bound locally, allowing `AdminStore` count
 * rollups under `FORCE ROW LEVEL SECURITY` without granting `BYPASSRLS`.
 */
export async function withOperatorReadTransaction<T>(
  source: PostgresSessionSource,
  work: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  return runScopedTransaction(
    source,
    "BEGIN TRANSACTION READ ONLY",
    "SELECT set_config('tollway.operator_read', 'on', true)",
    undefined,
    work,
  );
}
