import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildReceipt,
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMemoryReceiptArchive,
  encodeArchiveCursor,
  type ReceiptArchive,
  type ReceiptArchiveOptions,
  type ReceiptFilter,
} from "./receipt-archive.js";
import { createSqliteReceiptArchive } from "./receipt-archive-sqlite.js";

const PAYER_A = `G${"A".repeat(55)}`;
const PAYER_B = `G${"B".repeat(55)}`;
const PAYEE_A = `G${"C".repeat(55)}`;
const PAYEE_B = `G${"D".repeat(55)}`;
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

let signer: Ed25519Signer;
let otherSigner: Ed25519Signer;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("archive-test");
  otherSigner = await Ed25519Signer.generate("someone-else");
});

type Seed = {
  id: string;
  issuedAt: string;
  payer?: string;
  payee?: string;
  model?: "x402" | "mpp-charge" | "mpp-channel";
  network?: "testnet" | "mainnet";
  asset?: string;
  resource?: string;
  txHash?: string;
  channelId?: string;
  sequence?: number;
};

async function receipt(seed: Seed, by: Ed25519Signer = signer): Promise<SignedReceipt> {
  const model = seed.model ?? "x402";
  const settlement =
    model === "mpp-channel"
      ? {
          kind: "channel-commitment" as const,
          channelId: seed.channelId ?? "ch-1",
          sequence: seed.sequence ?? 1,
        }
      : { kind: "transaction" as const, txHash: seed.txHash ?? `tx-${seed.id}` };
  return signReceipt(
    buildReceipt({
      id: seed.id,
      issuedAt: seed.issuedAt,
      payer: seed.payer ?? PAYER_A,
      payee: seed.payee ?? PAYEE_A,
      amount: "1000",
      asset: seed.asset ?? USDC,
      resource: seed.resource ?? "/api/quotes",
      model,
      settlement,
      network: seed.network ?? "testnet",
    }),
    by,
  );
}

/** Minute `n` of a fixed day, so ordering is easy to read in assertions. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 10, 24, 0, minute)).toISOString();
}

/** Every page of a search, concatenated. */
async function allPages(
  archive: ReceiptArchive,
  filter: ReceiptFilter,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await archive.search(filter, cursor === undefined ? { limit } : { limit, cursor });
    ids.push(...page.items.map((item) => item.receipt.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
}

type Factory = (options?: ReceiptArchiveOptions) => ReceiptArchive;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const implementations: Array<[string, Factory]> = [
  ["memory", (options) => createMemoryReceiptArchive(options)],
  [
    "sqlite",
    (options) => {
      const archive = createSqliteReceiptArchive({ filename: ":memory:", ...options });
      cleanups.push(() => archive.close());
      return archive;
    },
  ],
];

describe.each(implementations)("receipt archive conformance: %s", (_name, create) => {
  it("appends a receipt once and treats an identical repeat as a duplicate", async () => {
    const archive = create();
    const r = await receipt({ id: "r1", issuedAt: at(1) });
    expect(await archive.append(r)).toBe("appended");
    expect(await archive.append(structuredClone(r))).toBe("duplicate");
    expect((await archive.search()).items).toHaveLength(1);
    expect(await archive.get("r1")).toEqual(r);
  });

  it("rejects a different body under an existing id and keeps the stored one", async () => {
    const archive = create();
    const original = await receipt({ id: "r1", issuedAt: at(1) });
    await archive.append(original);
    const forged = await receipt({ id: "r1", issuedAt: at(1), payee: PAYEE_B });
    await expect(archive.append(forged)).rejects.toMatchObject({ code: "receipt-conflict" });
    expect(await archive.get("r1")).toEqual(original);
  });

  it("returns undefined for an unknown id", async () => {
    expect(await create().get("missing")).toBeUndefined();
  });

  it("rejects a receipt that fails the schema", async () => {
    const archive = create();
    const r = await receipt({ id: "r1", issuedAt: at(1) });
    const broken = { ...r, receipt: { ...r.receipt, amount: "1.5" } };
    await expect(archive.append(broken)).rejects.toMatchObject({ code: "invalid-receipt" });
    await expect(archive.append({ nope: true })).rejects.toMatchObject({ code: "invalid-receipt" });
    expect((await archive.search()).items).toHaveLength(0);
  });

  it("stores only receipts the configured verifier accepts", async () => {
    const archive = create({ verifier: Ed25519Verifier.forSigner(signer) });
    expect(await archive.append(await receipt({ id: "ok", issuedAt: at(1) }))).toBe("appended");
    const foreign = await receipt({ id: "foreign", issuedAt: at(2) }, otherSigner);
    await expect(archive.append(foreign)).rejects.toMatchObject({ code: "invalid-receipt" });
    const r = await receipt({ id: "tampered", issuedAt: at(3) });
    const tampered = { ...r, receipt: { ...r.receipt, amount: "999999" } };
    await expect(archive.append(tampered)).rejects.toMatchObject({ code: "invalid-receipt" });
    expect((await archive.search()).items.map((item) => item.receipt.id)).toEqual(["ok"]);
  });

  it("orders newest first by issue time, then by id", async () => {
    const archive = create();
    for (const seed of [
      { id: "a", issuedAt: at(1) },
      { id: "c", issuedAt: at(2) },
      { id: "b", issuedAt: at(2) },
      { id: "d", issuedAt: at(3) },
    ]) {
      await archive.append(await receipt(seed));
    }
    expect((await archive.search()).items.map((item) => item.receipt.id)).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  describe("filters", () => {
    let archive: ReceiptArchive;

    async function seeded(): Promise<ReceiptArchive> {
      const fresh = create();
      const seeds: Seed[] = [
        { id: "x1", issuedAt: at(1), payer: PAYER_A, payee: PAYEE_A, resource: "/api/quotes" },
        { id: "x2", issuedAt: at(2), payer: PAYER_B, payee: PAYEE_A, resource: "/api/quotes/eur" },
        { id: "x3", issuedAt: at(3), payee: PAYEE_B, resource: "/apix", network: "mainnet" },
        {
          id: "c1",
          issuedAt: at(4),
          model: "mpp-charge",
          asset: "native",
          txHash: "tx-special",
          resource: "/charge",
        },
        {
          resource: "/stream",
          id: "ch1",
          issuedAt: at(5),
          model: "mpp-channel",
          channelId: "ch-9",
          sequence: 1,
        },
        {
          resource: "/stream",
          id: "ch2",
          issuedAt: at(6),
          model: "mpp-channel",
          channelId: "ch-9",
          sequence: 2,
        },
        {
          resource: "/stream",
          id: "ch3",
          issuedAt: at(7),
          model: "mpp-channel",
          channelId: "ch-7",
          sequence: 2,
        },
      ];
      for (const seed of seeds) await fresh.append(await receipt(seed));
      return fresh;
    }

    async function ids(filter: ReceiptFilter): Promise<string[]> {
      return (await archive.search(filter)).items.map((item) => item.receipt.id);
    }

    it.each<[string, ReceiptFilter, string[]]>([
      ["payer", { payer: PAYER_B }, ["x2"]],
      ["payee", { payee: PAYEE_B }, ["x3"]],
      ["model", { model: "mpp-channel" }, ["ch3", "ch2", "ch1"]],
      ["network", { network: "mainnet" }, ["x3"]],
      ["asset", { asset: "native" }, ["c1"]],
      ["exact resource", { resource: "/api/quotes" }, ["x1"]],
      ["resource prefix", { resourcePrefix: "/api/" }, ["x2", "x1"]],
      ["resource prefix without a slash", { resourcePrefix: "/api" }, ["x3", "x2", "x1"]],
      ["from", { from: at(6) }, ["ch3", "ch2"]],
      ["to", { to: at(2) }, ["x2", "x1"]],
      ["from and to", { from: at(3), to: at(4) }, ["c1", "x3"]],
      ["txHash", { txHash: "tx-special" }, ["c1"]],
      ["channelId", { channelId: "ch-9" }, ["ch2", "ch1"]],
      ["channelId and sequence", { channelId: "ch-9", sequence: 2 }, ["ch2"]],
      ["combined", { payee: PAYEE_A, resourcePrefix: "/api/", payer: PAYER_A }, ["x1"]],
    ])("filters by %s", async (_label, filter, expected) => {
      archive = await seeded();
      expect(await ids(filter)).toEqual(expected);
    });

    it("rejects a sequence without a channelId, and a bad time bound", async () => {
      archive = await seeded();
      await expect(archive.search({ sequence: 1 })).rejects.toMatchObject({
        code: "invalid-receipt-query",
      });
      await expect(archive.search({ from: "yesterday" })).rejects.toMatchObject({
        code: "invalid-receipt-query",
      });
    });
  });

  it("pages through several pages without gaps or repeats", async () => {
    const archive = create();
    for (let index = 0; index < 23; index++) {
      await archive.append(
        await receipt({ id: `p${String(index).padStart(2, "0")}`, issuedAt: at(index) }),
      );
    }
    const ids = await allPages(archive, {}, 5);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    expect(ids[0]).toBe("p22");
    expect(ids.at(-1)).toBe("p00");
  });

  it("keeps paging stable while receipts are appended between pages", async () => {
    const archive = create();
    const original: string[] = [];
    for (let index = 0; index < 12; index++) {
      const id = `s${String(index).padStart(2, "0")}`;
      original.push(id);
      await archive.append(await receipt({ id, issuedAt: at(index * 2) }));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let round = 0;
    for (;;) {
      const page = await archive.search(
        {},
        cursor === undefined ? { limit: 4 } : { limit: 4, cursor },
      );
      seen.push(...page.items.map((item) => item.receipt.id));
      // New receipts arrive between pages: newer than everything, older than
      // everything, and between two existing ones.
      round++;
      await archive.append(await receipt({ id: `new-late-${round}`, issuedAt: at(100 + round) }));
      await archive.append(await receipt({ id: `new-early-${round}`, issuedAt: at(-10 - round) }));
      await archive.append(await receipt({ id: `new-mid-${round}`, issuedAt: at(round * 4 + 1) }));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const kept = seen.filter((id) => original.includes(id));
    expect(kept).toEqual([...original].reverse());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("rejects malformed and edited cursors", async () => {
    const archive = create();
    await archive.append(await receipt({ id: "r1", issuedAt: at(1) }));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [
      "not a cursor!",
      encode("just a string"),
      encode({ t: Date.parse(at(1)) }),
      encode({ t: Date.parse(at(1)), i: "r1", extra: true }),
      encode({ t: "soon", i: "r1" }),
      encode({ i: "r1", t: Date.parse(at(1)) }),
      `${encodeArchiveCursor({ issuedAtMs: Date.parse(at(1)), id: "r1" })}A`,
    ]) {
      await expect(archive.search({}, { cursor })).rejects.toMatchObject({
        code: "invalid-cursor",
      });
    }
  });

  it("rejects a limit outside 1 to the maximum", async () => {
    const archive = create();
    for (const limit of [0, -1, 1.5, 501]) {
      await expect(archive.search({}, { limit })).rejects.toMatchObject({
        code: "invalid-receipt-query",
      });
    }
  });

  it("returns the receipts exactly as appended, including a v2 receipt", async () => {
    const archive = create();
    const v2 = await signReceipt(
      buildReceipt({
        id: "v2",
        issuedAt: at(1),
        payer: PAYER_A,
        payee: PAYEE_A,
        amount: "1000",
        asset: USDC,
        resource: "/api/quotes",
        model: "x402",
        settlement: { kind: "transaction", txHash: "tx-v2" },
        network: "testnet",
        offerHash: "A".repeat(43),
        method: "GET",
      }),
      signer,
    );
    await archive.append(v2);
    expect(await archive.get("v2")).toEqual(v2);
    expect((await archive.search()).items).toEqual([v2]);
  });

  it("concatenated pages equal the full sorted result for any data and page size", async () => {
    // Receipts are signed once and reused, so the property explores ordering
    // and page boundaries, not signing.
    const pool: SignedReceipt[] = [];
    for (let index = 0; index < 30; index++) {
      pool.push(await receipt({ id: `q${index}`, issuedAt: at(index % 7) }));
    }
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(pool, { minLength: 0, maxLength: pool.length }),
        fc.integer({ min: 1, max: 9 }),
        async (subset, pageSize) => {
          const archive = create();
          for (const item of subset) await archive.append(item);
          const full = (await archive.search({}, { limit: 500 })).items.map(
            (item) => item.receipt.id,
          );
          expect(full).toHaveLength(subset.length);
          expect(await allPages(archive, {}, pageSize)).toEqual(full);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("sqlite receipt archive", () => {
  let directory: string;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("keeps receipts across reopening the file", async () => {
    directory = mkdtempSync(join(tmpdir(), "tollway-archive-"));
    const filename = join(directory, "archive.db");
    const first = createSqliteReceiptArchive({ filename });
    const r = await receipt({ id: "kept", issuedAt: at(1) });
    await first.append(r);
    first.close();
    const second = createSqliteReceiptArchive({ filename });
    expect(await second.get("kept")).toEqual(r);
    expect(await second.append(r)).toBe("duplicate");
    second.close();
  });

  it("refuses a stored row that no longer matches the schema", async () => {
    directory = mkdtempSync(join(tmpdir(), "tollway-archive-"));
    const filename = join(directory, "archive.db");
    const archive = createSqliteReceiptArchive({ filename });
    await archive.append(await receipt({ id: "r1", issuedAt: at(1) }));
    const raw = new DatabaseSync(filename);
    raw.exec(`UPDATE archived_receipts SET canonical = '{"receipt":{}}' WHERE id = 'r1'`);
    raw.close();
    await expect(archive.get("r1")).rejects.toMatchObject({ code: "corrupt-receipt" });
    await expect(archive.search()).rejects.toMatchObject({ code: "corrupt-receipt" });
    archive.close();
  });

  it("indexes every filter column", () => {
    const archive = createSqliteReceiptArchive({ filename: ":memory:" });
    archive.close();
    directory = mkdtempSync(join(tmpdir(), "tollway-archive-"));
    const filename = join(directory, "archive.db");
    createSqliteReceiptArchive({ filename }).close();
    const raw = new DatabaseSync(filename);
    const indexed = new Set(
      (
        raw
          .prepare(
            "SELECT ii.name AS column FROM sqlite_master m, pragma_index_info(m.name) ii WHERE m.type = 'index' AND m.tbl_name = 'archived_receipts'",
          )
          .all() as Array<{ column: string }>
      ).map((row) => row.column),
    );
    raw.close();
    for (const column of [
      "issued_at_ms",
      "payer",
      "payee",
      "model",
      "network",
      "asset",
      "resource",
      "tx_hash",
      "channel_id",
      "sequence",
    ]) {
      expect(indexed.has(column), column).toBe(true);
    }
  });
});
