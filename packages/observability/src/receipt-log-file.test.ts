import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReceipt,
  createReceiptLog,
  Ed25519Signer,
  Ed25519Verifier,
  RECEIPT_LOG_GENESIS_HASH,
  type SignedReceipt,
  signReceipt,
  verifyReceiptLog,
} from "@vegaforge/tollway-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openJsonlReceiptLogStore, repairJsonlReceiptLog } from "./receipt-log-file.js";

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;
let dir: string;
let path: string;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("file-log-key");
  verifier = Ed25519Verifier.forSigner(signer);
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tollway-receipt-log-"));
  path = join(dir, "receipts.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function receipt(n: number): Promise<SignedReceipt> {
  return signReceipt(
    buildReceipt({
      id: `file-${n}`,
      payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      payee: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      amount: "1000",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      resource: "/api/weather",
      model: "x402",
      settlement: { kind: "transaction", txHash: n.toString(16).padStart(64, "0") },
      network: "testnet",
      issuedAt: "2026-11-24T12:00:00.000Z",
    }),
    signer,
  );
}

async function logOver(file: string) {
  const store = await openJsonlReceiptLogStore({ path: file });
  return { store, log: createReceiptLog({ store, logId: "file-log", verifier, signer }) };
}

describe("JSON Lines receipt log store", () => {
  it("writes one canonical line per entry and reopens at the same head", async () => {
    const { store, log } = await logOver(path);
    expect(await log.head()).toEqual({ size: 0, headHash: RECEIPT_LOG_GENESIS_HASH });
    for (let n = 0; n < 3; n += 1) {
      await log.append(await receipt(n));
    }
    const head = await log.head();
    await store.close();

    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");

    const reopened = await logOver(path);
    expect(await reopened.log.head()).toEqual(head);
    const e3 = await reopened.log.append(await receipt(3));
    expect(e3.seq).toBe(3);
    const entries = await reopened.log.read(0, 10);
    expect(entries).toHaveLength(4);
    expect(await reopened.log.read(2, 1)).toEqual([entries[2]]);
    expect(await verifyReceiptLog(entries, { verifier })).toMatchObject({ valid: true, size: 4 });
    await reopened.store.close();
  });

  it("keeps the chain intact under concurrent appends", async () => {
    const { store, log } = await logOver(path);
    const receipts = await Promise.all(Array.from({ length: 20 }, (_, n) => receipt(n)));
    await Promise.all(receipts.map((r) => log.append(r)));
    await store.close();
    const reopened = await logOver(path);
    expect(await verifyReceiptLog(await reopened.log.read(0, 50), { verifier })).toMatchObject({
      valid: true,
      size: 20,
    });
    await reopened.store.close();
  });

  it("refuses a file whose last line is partial until it is repaired", async () => {
    const { store, log } = await logOver(path);
    await log.append(await receipt(0));
    const e1 = await log.append(await receipt(1));
    await store.close();

    // A crash in the middle of writing the third line.
    appendFileSync(path, '{"appendedAt":"2026-11-24T12:00:00.000Z","entryHa');
    await expect(openJsonlReceiptLogStore({ path })).rejects.toMatchObject({
      code: "corrupt-receipt-log",
    });

    const repair = await repairJsonlReceiptLog(path);
    expect(repair.removedBytes).toBeGreaterThan(0);
    expect(await repairJsonlReceiptLog(path)).toEqual({ removedBytes: 0 });

    const reopened = await logOver(path);
    expect(await reopened.log.head()).toEqual({ size: 2, headHash: e1.entryHash });
    await reopened.store.close();
  });

  it("refuses a file whose chain was edited", async () => {
    const { store, log } = await logOver(path);
    await log.append(await receipt(0));
    await log.append(await receipt(1));
    await store.close();

    const edited = readFileSync(path, "utf8").replace('"amount":"1000"', '"amount":"9000"');
    writeFileSync(path, edited);
    await expect(openJsonlReceiptLogStore({ path })).rejects.toThrow(/modified-entry at seq 0/);
  });

  it("refuses an append that does not extend the head, and appends after close", async () => {
    const { store, log } = await logOver(path);
    const e0 = await log.append(await receipt(0));
    await expect(store.append(e0)).rejects.toMatchObject({ code: "receipt-log-conflict" });
    await store.close();
    await expect(log.append(await receipt(1))).rejects.toMatchObject({
      code: "corrupt-receipt-log",
    });
  });
});
