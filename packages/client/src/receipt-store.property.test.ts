import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceipt, Ed25519Signer, signReceipt } from "@vegaforge/tollway-core";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryReceiptStore, type ReceiptHistory } from "./receipt-store.js";
import { createSqliteReceiptStore } from "./sqlite-store.js";

let signer: Ed25519Signer;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("receipt-ledger-property");
});

const rowArbitrary: fc.Arbitrary<Row> = fc.record({
  asset: fc.constantFrom("USDC:GA5Z", "native"),
  payee: fc.constantFrom("GSERVICE1", "GSERVICE2"),
  model: fc.constantFrom<Row["model"]>("x402", "mpp-charge"),
  amount: fc.bigInt({ min: 0n, max: 10n ** 30n }).map((value) => value.toString()),
});

type Row = { asset: string; payee: string; model: "x402" | "mpp-charge"; amount: string };

/** The ledger totals the property's rows imply, computed independently. */
function expectedTotals(rows: Row[]): {
  byPayeeAsset: Array<{ payee: string; asset: string; amount: string; count: number }>;
  byModelAsset: Array<{ model: string; asset: string; amount: string; count: number }>;
} {
  const payeeKeys = new Map<
    string,
    { payee: string; asset: string; amount: bigint; count: number }
  >();
  const modelKeys = new Map<
    string,
    { model: string; asset: string; amount: bigint; count: number }
  >();
  for (const row of rows) {
    const payeeKey = `${row.payee}|${row.asset}`;
    const payee = payeeKeys.get(payeeKey) ?? {
      payee: row.payee,
      asset: row.asset,
      amount: 0n,
      count: 0,
    };
    payee.amount += BigInt(row.amount);
    payee.count += 1;
    payeeKeys.set(payeeKey, payee);

    const modelKey = `${row.model}|${row.asset}`;
    const model = modelKeys.get(modelKey) ?? {
      model: row.model,
      asset: row.asset,
      amount: 0n,
      count: 0,
    };
    model.amount += BigInt(row.amount);
    model.count += 1;
    modelKeys.set(modelKey, model);
  }
  const order = (a: { asset: string }, b: { asset: string }) =>
    a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0;
  return {
    byPayeeAsset: [...payeeKeys.values()]
      .sort((a, b) => order(a, b) || (a.payee < b.payee ? -1 : a.payee > b.payee ? 1 : 0))
      .map((total) => ({ ...total, asset: total.asset, amount: total.amount.toString() })),
    byModelAsset: [...modelKeys.values()]
      .sort((a, b) => order(a, b) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
      .map((total) => ({ ...total, asset: total.asset, amount: total.amount.toString() })),
  };
}

async function fill(store: ReceiptHistory, rows: Row[]): Promise<void> {
  for (const [index, row] of rows.entries()) {
    await store.put(
      await signReceipt(
        buildReceipt({
          id: `property-${index}`,
          issuedAt: `2026-11-2${index % 10}T10:00:0${index % 10}.000Z`,
          payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          payee: row.payee,
          amount: row.amount,
          asset: row.asset,
          resource: "/property",
          model: row.model,
          settlement: { kind: "transaction", txHash: `tx-${index}` },
          network: "testnet",
        }),
        signer,
      ),
    );
  }
}

describe("spend ledger property", () => {
  it("equals the sum of stored amounts for random receipt sets (memory)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(rowArbitrary, { maxLength: 30 }), async (rows) => {
        const store = createMemoryReceiptStore();
        await fill(store, rows);
        const totals = await store.totals();
        expect(totals.byPayeeAsset).toEqual(expectedTotals(rows).byPayeeAsset);
        expect(totals.byModelAsset).toEqual(expectedTotals(rows).byModelAsset);
      }),
      { numRuns: 100 },
    );
  });

  it("equals the sum of stored amounts for random receipt sets (sqlite)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tollway-ledger-property-"));
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(rowArbitrary, { maxLength: 20 }), async (rows) => {
          // A fresh file per run, so a failing sample leaves no state behind.
          const path = join(dir, `run-${crypto.randomUUID()}.db`);
          const store = createSqliteReceiptStore({ path });
          try {
            await fill(store, rows);
            const totals = await store.totals();
            expect(totals.byPayeeAsset).toEqual(expectedTotals(rows).byPayeeAsset);
            expect(totals.byModelAsset).toEqual(expectedTotals(rows).byModelAsset);
          } finally {
            store.close();
            await rm(path, { force: true });
          }
        }),
        { numRuns: 25 },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
