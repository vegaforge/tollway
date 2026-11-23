import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildReceipt,
  bytesToBase64Url,
  Ed25519Signer,
  type SignedReceipt,
  signReceipt,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMemoryReceiptStore,
  MAX_RECEIPT_PAGE_SIZE,
  type ReceiptHistory,
} from "./receipt-store.js";
import { createSqliteReceiptStore, SQLITE_RECEIPT_SCHEMA_VERSION } from "./sqlite-store.js";

let signer: Ed25519Signer;
let sequence = 0;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("receipt-store-test");
});

type ReceiptInput = {
  id?: string;
  issuedAt?: string;
  payee?: string;
  asset?: string;
  model?: "x402" | "mpp-charge" | "mpp-channel";
  amount?: string;
  resource?: string;
};

async function makeReceipt(input: ReceiptInput = {}): Promise<SignedReceipt> {
  sequence += 1;
  const model = input.model ?? "x402";
  return signReceipt(
    buildReceipt({
      id: input.id ?? `receipt-${sequence}`,
      issuedAt: input.issuedAt ?? `2026-11-2${sequence % 10}T10:00:00.000Z`,
      payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: input.payee ?? "GPAYEEAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: input.amount ?? "10000",
      asset: input.asset ?? "USDC:GA5Z",
      resource: input.resource ?? "/quotes/latest",
      model,
      settlement:
        model === "mpp-channel"
          ? { kind: "channel-commitment", channelId: "channel-1", sequence: 1 }
          : { kind: "transaction", txHash: "tx-hash" },
      network: "testnet",
    }),
    signer,
  );
}

type OpenedStore = { store: ReceiptHistory; close: () => Promise<void> };

const backends: Array<{ name: string; open: () => Promise<OpenedStore> }> = [
  {
    name: "memory store",
    open: async () => ({ store: createMemoryReceiptStore(), close: async () => undefined }),
  },
  {
    name: "sqlite store",
    open: async () => {
      const dir = await mkdtemp(join(tmpdir(), "tollway-receipts-"));
      const store = createSqliteReceiptStore({ path: join(dir, "receipts.db") });
      return {
        store,
        close: async () => {
          store.close();
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(backends)("$name", ({ open }) => {
  let opened: OpenedStore;

  afterEach(async () => {
    await opened.close();
  });

  it("stores a receipt and returns it by id", async () => {
    opened = await open();
    const receipt = await makeReceipt();

    await opened.store.put(receipt);

    await expect(opened.store.get(receipt.receipt.id)).resolves.toEqual(receipt);
  });

  it("is idempotent by receipt id: a replay leaves one receipt and keeps the first", async () => {
    opened = await open();
    const first = await makeReceipt({ id: "same-id", amount: "10000" });
    const replay = await makeReceipt({ id: "same-id", amount: "999999" });

    await opened.store.put(first);
    await opened.store.put(replay);

    await expect(opened.store.get("same-id")).resolves.toEqual(first);
    await expect(opened.store.query()).resolves.toMatchObject({ items: [first] });
  });

  it("returns null for an id the store has never seen", async () => {
    opened = await open();
    await expect(opened.store.get("missing")).resolves.toBeNull();
  });

  it("filters by payee, asset, model and resource", async () => {
    opened = await open();
    const wanted = await makeReceipt({
      payee: "GSERVICE1",
      asset: "USDC:GA5Z",
      model: "mpp-charge",
      resource: "/inference",
    });
    await opened.store.put(wanted);
    await opened.store.put(await makeReceipt({ payee: "GSERVICE2" }));
    await opened.store.put(await makeReceipt({ asset: "native" }));
    await opened.store.put(await makeReceipt({ model: "mpp-channel" }));
    await opened.store.put(await makeReceipt({ resource: "/other" }));

    await expect(
      opened.store.query({
        payee: "GSERVICE1",
        asset: "USDC:GA5Z",
        model: "mpp-charge",
        resource: "/inference",
      }),
    ).resolves.toMatchObject({ items: [wanted] });
    await expect(opened.store.query({ asset: "native" })).resolves.toMatchObject({
      items: [expect.objectContaining({ receipt: expect.objectContaining({ asset: "native" }) })],
    });
  });

  it("filters by an inclusive issuedAt window", async () => {
    opened = await open();
    const early = await makeReceipt({ id: "early", issuedAt: "2026-06-26T09:59:59.999Z" });
    const inside = await makeReceipt({ id: "inside", issuedAt: "2026-06-26T10:00:00.000Z" });
    const edge = await makeReceipt({ id: "edge", issuedAt: "2026-06-26T10:30:00.000Z" });
    const late = await makeReceipt({ id: "late", issuedAt: "2026-06-26T10:30:00.001Z" });
    for (const receipt of [early, inside, edge, late]) await opened.store.put(receipt);

    const result = await opened.store.query({
      from: "2026-06-26T10:00:00.000Z",
      to: "2026-06-26T10:30:00.000Z",
    });

    expect(result.items.map((receipt) => receipt.receipt.id)).toEqual(["edge", "inside"]);
  });

  it("pages newest first across the whole result with a stable order", async () => {
    opened = await open();
    const receipts = [
      await makeReceipt({ id: "a", issuedAt: "2026-11-20T10:00:00.000Z" }),
      await makeReceipt({ id: "b", issuedAt: "2026-11-21T10:00:00.000Z" }),
      await makeReceipt({ id: "c", issuedAt: "2026-11-21T10:00:00.000Z" }),
      await makeReceipt({ id: "d", issuedAt: "2026-11-22T10:00:00.000Z" }),
      await makeReceipt({ id: "e", issuedAt: "2026-11-19T10:00:00.000Z" }),
    ];
    for (const receipt of receipts) await opened.store.put(receipt);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await opened.store.query({}, { limit: 2, cursor });
      seen.push(...result.items.map((receipt) => receipt.receipt.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(["d", "c", "b", "a", "e"]);
    expect(cursor).toBeUndefined();
  });

  it("returns no next cursor when the page is exactly the whole result", async () => {
    opened = await open();
    await opened.store.put(await makeReceipt({ id: "only" }));

    const result = await opened.store.query({}, { limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeUndefined();
  });

  it("rejects a cursor it did not produce", async () => {
    opened = await open();
    await opened.store.put(await makeReceipt());

    // A well-formed base64url string whose JSON is not a keyset, and one with
    // a field the store never writes. Both must be refused.
    const wrongShape = bytesToBase64Url(
      utf8Bytes(JSON.stringify({ issuedAt: "x", id: "y", extra: 1 })),
    );
    for (const cursor of ["not base64url!", "bm90LWpzb24", wrongShape]) {
      await expect(opened.store.query({}, { cursor })).rejects.toMatchObject({
        code: "invalid-cursor",
      });
    }
  });

  it("rejects a page limit outside 1 to the maximum", async () => {
    opened = await open();
    for (const limit of [0, -1, 1.5, MAX_RECEIPT_PAGE_SIZE + 1]) {
      await expect(opened.store.query({}, { limit })).rejects.toMatchObject({
        code: "invalid-receipt-query",
      });
    }
  });

  it("returns a copy, so mutating a receipt the store handed out changes nothing", async () => {
    opened = await open();
    const receipt = await makeReceipt();
    await opened.store.put(receipt);

    const first = await opened.store.get(receipt.receipt.id);
    if (!first) throw new Error("the store lost the receipt it just wrote");
    first.receipt.amount = "1";

    await expect(opened.store.get(receipt.receipt.id)).resolves.toEqual(receipt);
  });

  it("rejects a receipt that does not match the signed receipt schema", async () => {
    opened = await open();
    const receipt = await makeReceipt();
    const malformed = {
      ...receipt,
      receipt: { ...receipt.receipt, amount: "1.5" },
    } as unknown as SignedReceipt;

    await expect(opened.store.put(malformed)).rejects.toMatchObject({ code: "corrupt-receipt" });
  });

  it("reports spend per payee and model without ever adding two assets together", async () => {
    opened = await open();
    await opened.store.put(
      await makeReceipt({ id: "1", payee: "GSERVICE1", asset: "USDC:GA5Z", amount: "1000" }),
    );
    await opened.store.put(
      await makeReceipt({
        id: "2",
        payee: "GSERVICE1",
        asset: "USDC:GA5Z",
        amount: "250",
        model: "mpp-charge",
      }),
    );
    await opened.store.put(
      await makeReceipt({ id: "3", payee: "GSERVICE2", asset: "native", amount: "7" }),
    );

    const totals = await opened.store.totals();

    expect(totals.byPayeeAsset).toEqual([
      { payee: "GSERVICE1", asset: "USDC:GA5Z", amount: "1250", count: 2 },
      { payee: "GSERVICE2", asset: "native", amount: "7", count: 1 },
    ]);
    expect(totals.byModelAsset).toEqual([
      { model: "mpp-charge", asset: "USDC:GA5Z", amount: "250", count: 1 },
      { model: "x402", asset: "USDC:GA5Z", amount: "1000", count: 1 },
      { model: "x402", asset: "native", amount: "7", count: 1 },
    ]);
  });

  it("narrows totals by the same filters as a query", async () => {
    opened = await open();
    await opened.store.put(
      await makeReceipt({
        id: "1",
        payee: "GSERVICE1",
        issuedAt: "2026-11-20T10:00:00.000Z",
        amount: "1000",
      }),
    );
    await opened.store.put(
      await makeReceipt({
        id: "2",
        payee: "GSERVICE1",
        issuedAt: "2026-11-21T10:00:00.000Z",
        amount: "500",
      }),
    );
    await opened.store.put(await makeReceipt({ id: "3", payee: "GSERVICE2", amount: "80" }));

    const totals = await opened.store.totals({
      payee: "GSERVICE1",
      from: "2026-11-21T00:00:00.000Z",
    });

    expect(totals.byPayeeAsset).toEqual([
      { payee: "GSERVICE1", asset: "USDC:GA5Z", amount: "500", count: 1 },
    ]);
  });

  it("keeps amounts exact past Number.MAX_SAFE_INTEGER", async () => {
    opened = await open();
    await opened.store.put(await makeReceipt({ id: "1", amount: "9007199254740993" }));
    await opened.store.put(await makeReceipt({ id: "2", amount: "9007199254740993" }));

    const totals = await opened.store.totals();

    expect(totals.byPayeeAsset[0]?.amount).toBe("18014398509481986");
  });
});

describe("sqlite receipt store specifics", () => {
  async function openFile(): Promise<{
    store: ReturnType<typeof createSqliteReceiptStore>;
    path: string;
    dir: string;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "tollway-receipts-"));
    const path = join(dir, "receipts.db");
    return { store: createSqliteReceiptStore({ path }), path, dir };
  }

  it("records the schema version and the indexes the queries rely on", async () => {
    const { store, path, dir } = await openFile();
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      const versions = db.prepare("SELECT version FROM schema_version").all();
      expect(versions).toEqual([{ version: SQLITE_RECEIPT_SCHEMA_VERSION }]);
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receipts'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toEqual(
        expect.arrayContaining(["receipts_issued_at", "receipts_payee", "receipts_asset"]),
      );
      const columns = db
        .prepare("SELECT name, type FROM pragma_table_info('receipts')")
        .all() as Array<{ name: string; type: string }>;
      expect(columns.find((column) => column.name === "amount")).toEqual({
        name: "amount",
        type: "TEXT",
      });
      db.close();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a corrupted row as an error instead of returning a malformed receipt", async () => {
    const { store, path, dir } = await openFile();
    try {
      const receipt = await makeReceipt({ id: "corrupt-me" });
      await store.put(receipt);

      const db = new DatabaseSync(path);
      db.prepare("UPDATE receipts SET receipt = ? WHERE id = ?").run("{not json", "corrupt-me");
      db.close();

      await expect(store.get("corrupt-me")).rejects.toMatchObject({ code: "corrupt-receipt" });
      await expect(store.query()).rejects.toMatchObject({ code: "corrupt-receipt" });
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a database written by another schema version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tollway-receipts-"));
    const path = join(dir, "receipts.db");
    try {
      const first = createSqliteReceiptStore({ path });
      first.close();

      const db = new DatabaseSync(path);
      db.prepare("UPDATE schema_version SET version = ?").run(SQLITE_RECEIPT_SCHEMA_VERSION + 1);
      db.close();

      expect(() => createSqliteReceiptStore({ path })).toThrowError(/schema version/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
