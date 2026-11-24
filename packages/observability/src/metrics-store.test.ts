import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createObservabilityHub, type PaymentMetric } from "./index.js";
import { createMemoryMetricsStore } from "./memory-metrics-store.js";
import { InvalidMetricError, type MetricsStore } from "./metrics-store.js";
import {
  createPostgresMetricsStore,
  migratePostgresMetricsStore,
} from "./postgres-metrics-store.js";
import { createSqliteMetricsStore } from "./sqlite-metrics-store.js";
import { createFakePostgres } from "./test-support/fake-postgres.js";

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: "GPAYER",
    payee: "GSERVICE",
    model: "x402",
    amount: "100",
    asset: "USDC:GA5Z",
    latencyMs: 40,
    outcome: "settled",
    at: "2026-11-20T10:00:00.000Z",
    ...overrides,
  };
}

/** Five metrics that differ in every filterable field. */
const FIXTURE: PaymentMetric[] = [
  metric({ at: "2026-11-20T10:00:00.000Z" }),
  metric({ payer: "GOTHER", amount: "250", at: "2026-11-20T10:01:00.000Z" }),
  metric({ payee: "GSECOND", model: "mpp-charge", amount: "7", at: "2026-11-20T10:02:00.000Z" }),
  metric({ asset: "XLM", amount: "3", outcome: "failed", at: "2026-11-20T10:03:00.000Z" }),
  // The same instant as 10:04Z, written with an offset.
  metric({ amount: "40", at: "2026-11-20T11:04:00+01:00" }),
];

type Factory = { name: string; open: () => Promise<MetricsStore> };

const opened: MetricsStore[] = [];

const factories: Factory[] = [
  { name: "memory", open: async () => createMemoryMetricsStore() },
  { name: "sqlite", open: async () => createSqliteMetricsStore({ filename: ":memory:" }) },
  {
    name: "postgres (fake client)",
    open: async () => {
      const client = createFakePostgres();
      await migratePostgresMetricsStore(client);
      return createPostgresMetricsStore({ client });
    },
  },
];

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
});

async function seeded(factory: Factory, metrics = FIXTURE): Promise<MetricsStore> {
  const store = await factory.open();
  opened.push(store);
  await store.append(metrics);
  return store;
}

describe.each(factories)("MetricsStore conformance: $name", (factory) => {
  it("returns appended metrics in recording order", async () => {
    const store = await seeded(factory);
    const page = await store.query();
    expect(page.metrics).toEqual(FIXTURE);
    expect(page.nextCursor).toBeUndefined();
  });

  it.each([
    [{ payer: "GOTHER" }, [1]],
    [{ payee: "GSECOND" }, [2]],
    [{ model: "mpp-charge" as const }, [2]],
    // Bounds are inclusive and compare instants, so the +01:00 row is 10:04Z.
    [{ from: "2026-11-20T10:01:00.000Z", to: "2026-11-20T10:03:00.000Z" }, [1, 2, 3]],
    [{ from: "2026-11-20T10:04:00Z" }, [4]],
    [{ asset: "XLM" }, [3]],
    [{ outcome: "failed" as const }, [3]],
  ])("filters by %o", async (query, indexes) => {
    const store = await seeded(factory);
    const page = await store.query(query);
    expect(page.metrics).toEqual(indexes.map((index) => FIXTURE[index]));
  });

  it("walks every page exactly once", async () => {
    const store = await seeded(factory);
    const seen: PaymentMetric[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.query(
        {},
        cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
      );
      seen.push(...page.metrics);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(FIXTURE);
  });

  it("pages a filtered query without skipping matches", async () => {
    const store = await seeded(factory);
    const first = await store.query({ payee: "GSERVICE" }, { limit: 2 });
    expect(first.metrics).toEqual([FIXTURE[0], FIXTURE[1]]);
    const second = await store.query({ payee: "GSERVICE" }, { limit: 2, cursor: first.nextCursor });
    expect(second.metrics).toEqual([FIXTURE[3], FIXTURE[4]]);
    expect(second.nextCursor).toBeUndefined();
  });

  it.each([0, -1, 1.5, 10_001])("refuses a page limit of %s", async (limit) => {
    const store = await seeded(factory);
    await expect(store.query({}, { limit })).rejects.toMatchObject({
      code: "invalid-metrics-query",
    });
  });

  it("refuses a cursor it did not issue", async () => {
    const store = await seeded(factory);
    await expect(store.query({}, { cursor: "abc" })).rejects.toMatchObject({
      code: "invalid-metrics-query",
    });
  });

  it("summarizes exactly like the in-memory hub", async () => {
    const store = await seeded(factory);
    const hub = createObservabilityHub();
    for (const m of FIXTURE) hub.record(m);
    expect(await store.summarize()).toEqual(hub.summarize());
    expect(await store.summarize({ payee: "GSERVICE" })).toEqual(
      hub.summarize({ payee: "GSERVICE" }),
    );
    expect(await store.summarize({ outcome: "failed" })).toEqual(
      hub.summarize({ outcome: "failed" }),
    );
    expect(await store.summarize({ asset: "XLM" })).toEqual(hub.summarize({ asset: "XLM" }));
  });

  it("adds only settled amounts, but counts every outcome", async () => {
    const store = await seeded(factory);
    const summary = await store.summarize();
    // FIXTURE[3] failed with 3 XLM: it is an attempt, not spend.
    expect(summary.count).toBe(5);
    expect(summary.byOutcome).toEqual({ settled: 4, failed: 1, skipped: 0 });
    expect(summary.byAsset).toEqual({ "USDC:GA5Z": "397" });
    expect(summary.byModelAsset).toEqual([
      { model: "mpp-charge", asset: "USDC:GA5Z", amount: "7", count: 1 },
      { model: "x402", asset: "USDC:GA5Z", amount: "390", count: 3 },
    ]);
    expect(summary.byPayerAsset).toEqual([
      { payer: "GOTHER", asset: "USDC:GA5Z", amount: "250", count: 1 },
      { payer: "GPAYER", asset: "USDC:GA5Z", amount: "147", count: 3 },
    ]);
  });

  it("sums amounts beyond 2^53 exactly", async () => {
    const big = (2n ** 70n).toString();
    const store = await seeded(factory, [metric({ amount: big }), metric({ amount: big })]);
    const summary = await store.summarize();
    expect(summary.totalAmount).toBe((2n ** 71n).toString());
    expect(summary.byAsset["USDC:GA5Z"]).toBe((2n ** 71n).toString());
  });

  it("summarizes an empty window as zero", async () => {
    const store = await seeded(factory, []);
    expect(await store.summarize()).toEqual({
      totalAmount: "0",
      count: 0,
      byOutcome: { settled: 0, failed: 0, skipped: 0 },
      byAsset: {},
      byModel: {},
      byPayer: {},
      byPayee: {},
      byModelAsset: [],
      byPayerAsset: [],
      byPayeeAsset: [],
    });
  });

  it.each([
    ["a decimal amount", { amount: "1.5" }, "amount"],
    ["a negative amount", { amount: "-1" }, "amount"],
    ["an empty payer", { payer: "" }, "payer"],
    ["an unknown model", { model: "y402" as PaymentMetric["model"] }, "model"],
    ["a timestamp without a zone", { at: "2026-11-20T10:00:00" }, "at"],
    ["a negative latency", { latencyMs: -1 }, "latencyMs"],
  ])("refuses %s and writes nothing from the batch", async (_name, overrides, field) => {
    const store = await seeded(factory, []);
    const error = await store.append([metric(), metric(overrides)]).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(InvalidMetricError);
    expect(error).toMatchObject({ code: "invalid-metric", field });
    expect((await store.query()).metrics).toEqual([]);
  });

  it("rejects every call once closed", async () => {
    const store = await factory.open();
    await store.close();
    await expect(store.append([metric()])).rejects.toThrow(/closed/);
    await expect(store.query()).rejects.toThrow(/closed/);
    await expect(store.summarize()).rejects.toThrow(/closed/);
  });
});

describe("SQLite metrics store", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("keeps metrics across a restart, and migrating again changes nothing", async () => {
    dir = await mkdtemp(join(tmpdir(), "tollway-metrics-"));
    const filename = join(dir, "metrics.db");
    const first = createObservabilityHub({
      store: createSqliteMetricsStore({ filename }),
      onStoreError: (error) => {
        throw error;
      },
    });
    for (const m of FIXTURE) first.record(m);
    await first.close();

    const reopened = createSqliteMetricsStore({ filename });
    opened.push(reopened);
    const hub = createObservabilityHub();
    for (const m of FIXTURE) hub.record(m);
    expect(await reopened.summarize()).toEqual(hub.summarize());
    expect((await reopened.query()).metrics).toEqual(FIXTURE);
  });

  it("refuses a corrupt row written by another writer instead of summing it", async () => {
    dir = await mkdtemp(join(tmpdir(), "tollway-metrics-"));
    const filename = join(dir, "metrics.db");
    const store = createSqliteMetricsStore({ filename });
    opened.push(store);
    await store.append([metric()]);
    const other = new DatabaseSync(filename);
    other.exec(
      "INSERT INTO tollway_metrics (payer, payee, model, amount, asset, latency_ms, outcome, at, at_ms) VALUES ('P', 'S', 'x402', '1.5', 'A', 1, 'settled', '2026-11-20T10:00:00.000Z', 0)",
    );
    other.close();
    await expect(store.summarize()).rejects.toBeInstanceOf(InvalidMetricError);
  });

  it("refuses a table prefix that is not a plain identifier", () => {
    expect(() =>
      createSqliteMetricsStore({ filename: ":memory:", tablePrefix: "x; DROP" }),
    ).toThrow(TypeError);
  });
});

describe("Postgres metrics store", () => {
  it("migrates idempotently and records the schema version once", async () => {
    const client = createFakePostgres();
    await migratePostgresMetricsStore(client);
    await migratePostgresMetricsStore(client);
    const versions = client.db.prepare("SELECT version FROM tollway_metrics_schema").all();
    expect(versions).toEqual([{ version: 1 }]);
  });

  it("sums in one statement with NUMERIC, never in JavaScript numbers", async () => {
    const client = createFakePostgres();
    await migratePostgresMetricsStore(client);
    const store = createPostgresMetricsStore({ client });
    await store.append(FIXTURE);
    client.statements.length = 0;
    await store.summarize();
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]).toContain("SUM(amount)::text");
    expect(client.statements[0]).toContain("UNION ALL");
  });

  it("declares amounts as NUMERIC(78, 0) and indexes every filter column", async () => {
    const client = createFakePostgres();
    await migratePostgresMetricsStore(client);
    const ddl = client.statements.join("\n");
    expect(ddl).toContain("amount NUMERIC(78, 0) NOT NULL");
    for (const column of ["at_ms", "payer", "payee", "model"]) {
      expect(ddl).toContain(`(${column})`);
    }
  });
});
