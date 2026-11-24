import { beforeAll, describe, expect, it, vi } from "vitest";
import { TollwayError } from "../errors.js";
import { buildReceipt, signReceipt } from "./receipt.js";
import {
  computeReceiptLogEntryHash,
  createMemoryReceiptLogStore,
  createReceiptLog,
  RECEIPT_LOG_GENESIS_HASH,
  type ReceiptLogEntry,
  type ReceiptLogStore,
  type SignedReceiptLogCheckpoint,
  verifyReceiptLog,
  verifyReceiptLogCheckpoint,
} from "./receipt-log.js";
import type { SignedReceipt } from "./schema.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

const PAYER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const PAYEE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const T0 = Date.parse("2026-11-24T12:00:00.000Z");

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;
let stranger: Ed25519Signer;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("log-key");
  verifier = Ed25519Verifier.forSigner(signer);
  stranger = await Ed25519Signer.generate("log-key");
});

async function receipt(n: number, by: Ed25519Signer = signer): Promise<SignedReceipt> {
  return signReceipt(
    buildReceipt({
      id: `r-${n}`,
      payer: PAYER,
      payee: PAYEE,
      amount: String(1000 + n),
      asset: ASSET,
      resource: "/api/weather",
      model: "x402",
      settlement: { kind: "transaction", txHash: n.toString(16).padStart(64, "0") },
      network: "testnet",
      issuedAt: new Date(T0).toISOString(),
    }),
    by,
  );
}

/** Index into a list in a test, failing loudly instead of asserting non-null. */
function entryAt(list: ReceiptLogEntry[], index: number): ReceiptLogEntry {
  const entry = list[index];
  if (!entry) throw new Error(`no entry at ${index}`);
  return entry;
}

function newLog(store: ReceiptLogStore = createMemoryReceiptLogStore()) {
  let tick = T0;
  return createReceiptLog({ store, logId: "log-main", verifier, signer, now: () => tick++ });
}

async function filledLog(count: number) {
  const log = newLog();
  for (let n = 0; n < count; n += 1) {
    await log.append(await receipt(n));
  }
  return log;
}

describe("receipt log append, head and read", () => {
  it("chains entries from the genesis hash and reads them back in order", async () => {
    const log = newLog();
    expect(await log.head()).toEqual({ size: 0, headHash: RECEIPT_LOG_GENESIS_HASH });

    const e0 = await log.append(await receipt(0));
    const e1 = await log.append(await receipt(1));
    const e2 = await log.append(await receipt(2));

    expect(e0.seq).toBe(0);
    expect(e0.prevHash).toBe(RECEIPT_LOG_GENESIS_HASH);
    expect(e1.prevHash).toBe(e0.entryHash);
    expect(e2.prevHash).toBe(e1.entryHash);
    expect(e0.entryHash).toBe(
      await computeReceiptLogEntryHash({
        seq: 0,
        prevHash: RECEIPT_LOG_GENESIS_HASH,
        receipt: e0.receipt,
        appendedAt: e0.appendedAt,
      }),
    );
    expect(await log.head()).toEqual({ size: 3, headHash: e2.entryHash });
    expect(await log.read(1, 10)).toEqual([e1, e2]);
    expect(await log.read(0, 1)).toEqual([e0]);
    expect(await log.read(3, 5)).toEqual([]);
  });

  it("rejects a bad read range", async () => {
    const log = newLog();
    await expect(log.read(-1, 1)).rejects.toThrow(RangeError);
    await expect(log.read(0, 0)).rejects.toThrow(RangeError);
  });

  it("refuses a receipt that does not verify and writes nothing", async () => {
    const log = newLog();
    const forged = await receipt(0, stranger);
    await expect(log.append(forged)).rejects.toMatchObject({
      code: "receipt-verification-failed",
    });
    await expect(log.append({ not: "a receipt" })).rejects.toBeInstanceOf(TollwayError);
    expect((await log.head()).size).toBe(0);
    // The queue keeps working after a rejected append.
    await log.append(await receipt(1));
    expect((await log.head()).size).toBe(1);
  });

  it("never forks the chain under concurrent appends", async () => {
    const log = newLog();
    const receipts = await Promise.all(Array.from({ length: 40 }, (_, n) => receipt(n)));
    const entries = await Promise.all(receipts.map((r) => log.append(r)));

    expect(entries.map((e) => e.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, n) => n),
    );
    const all = await log.read(0, 100);
    expect(await verifyReceiptLog(all, { verifier })).toMatchObject({ valid: true, size: 40 });
  });

  it("lets the store refuse an entry that does not extend its head", async () => {
    const store = createMemoryReceiptLogStore();
    const log = newLog(store);
    const e0 = await log.append(await receipt(0));
    await expect(store.append(e0)).rejects.toMatchObject({ code: "receipt-log-conflict" });
  });
});

describe("receipt log checkpoints", () => {
  it("signs a checkpoint on demand that verifies and names the head", async () => {
    const log = await filledLog(3);
    const cp = await log.checkpoint();
    const head = await log.head();
    expect(cp.checkpoint).toMatchObject({ logId: "log-main", size: 3, headHash: head.headHash });
    expect(log.latestCheckpoint()).toEqual(cp);
    expect(await verifyReceiptLogCheckpoint(cp, verifier, { logId: "log-main" })).toMatchObject({
      valid: true,
    });
    expect(await verifyReceiptLogCheckpoint(cp, verifier, { logId: "other" })).toMatchObject({
      valid: false,
    });
  });

  it("signs a checkpoint every N appends and hands it to onCheckpoint", async () => {
    const published: SignedReceiptLogCheckpoint[] = [];
    const log = createReceiptLog({
      store: createMemoryReceiptLogStore(),
      logId: "log-auto",
      verifier,
      signer,
      checkpointEvery: 2,
      onCheckpoint: (cp) => {
        published.push(cp);
      },
      onCheckpointError: () => {
        throw new Error("not expected");
      },
    });
    for (let n = 0; n < 5; n += 1) {
      await log.append(await receipt(n));
    }
    expect(published.map((cp) => cp.checkpoint.size)).toEqual([2, 4]);
  });

  it("reports a failed automatic checkpoint without failing the append", async () => {
    const onCheckpointError = vi.fn();
    const log = createReceiptLog({
      store: createMemoryReceiptLogStore(),
      logId: "log-auto",
      verifier,
      signer,
      checkpointEvery: 1,
      onCheckpoint: () => {
        throw new Error("webhook down");
      },
      onCheckpointError,
    });
    const entry = await log.append(await receipt(0));
    expect(entry.seq).toBe(0);
    expect(onCheckpointError).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it("refuses bad checkpoint configuration and on-demand checkpoints without a signer", async () => {
    const base = { store: createMemoryReceiptLogStore(), logId: "x", verifier };
    expect(() =>
      createReceiptLog({ ...base, signer, checkpointEvery: 0, onCheckpointError: () => {} }),
    ).toThrow(RangeError);
    expect(() =>
      createReceiptLog({ ...base, checkpointEvery: 2, onCheckpointError: () => {} }),
    ).toThrow(TypeError);
    await expect(createReceiptLog(base).checkpoint()).rejects.toMatchObject({
      code: "invalid-signing-key",
    });
  });
});

describe("verifyReceiptLog failure kinds", () => {
  async function setup() {
    const log = await filledLog(4);
    const checkpoint = await log.checkpoint();
    const entries = await log.read(0, 10);
    return { entries, checkpoint };
  }

  it("accepts an untouched log, with and without a checkpoint", async () => {
    const { entries, checkpoint } = await setup();
    expect(await verifyReceiptLog(entries, { verifier, checkpoint, logId: "log-main" })).toEqual({
      valid: true,
      size: 4,
      headHash: entries[3]?.entryHash,
    });
    expect(await verifyReceiptLog([])).toEqual({
      valid: true,
      size: 0,
      headHash: RECEIPT_LOG_GENESIS_HASH,
    });
  });

  it("reports a modified entry", async () => {
    const { entries } = await setup();
    const tampered = structuredClone(entries) as ReceiptLogEntry[];
    entryAt(tampered, 2).receipt.receipt.amount = "999999";
    expect(await verifyReceiptLog(tampered, { verifier })).toMatchObject({
      valid: false,
      kind: "modified-entry",
      seq: 2,
    });
  });

  it("reports a broken link when an entry is rehashed but its successor is not", async () => {
    const { entries } = await setup();
    const tampered = structuredClone(entries) as ReceiptLogEntry[];
    const target = entryAt(tampered, 1);
    target.appendedAt = new Date(T0 + 99_000).toISOString();
    target.entryHash = await computeReceiptLogEntryHash(target);
    expect(await verifyReceiptLog(tampered)).toMatchObject({
      valid: false,
      kind: "broken-link",
      seq: 2,
    });
  });

  it("reports a gap and a reorder", async () => {
    const { entries } = await setup();
    const [e0, e1, e2, e3] = entries as [
      ReceiptLogEntry,
      ReceiptLogEntry,
      ReceiptLogEntry,
      ReceiptLogEntry,
    ];
    expect(await verifyReceiptLog([e0, e2, e3])).toMatchObject({
      kind: "gap-or-reorder",
      seq: 1,
    });
    expect(await verifyReceiptLog([e0, e1, e3, e2])).toMatchObject({
      kind: "gap-or-reorder",
      seq: 2,
    });
  });

  it("reports a receipt whose own signature does not verify", async () => {
    const log = createReceiptLog({
      store: createMemoryReceiptLogStore(),
      logId: "log-main",
      verifier: Ed25519Verifier.forSigner(stranger),
    });
    await log.append(await receipt(0, stranger));
    await log.append(await receipt(1, stranger));
    const entries = await log.read(0, 10);
    expect(await verifyReceiptLog(entries, { verifier })).toMatchObject({
      valid: false,
      kind: "receipt-signature",
      seq: 0,
    });
  });

  it("reports truncation against a checkpoint, and cannot see it without one", async () => {
    const { entries, checkpoint } = await setup();
    const truncated = entries.slice(0, 2);
    expect(await verifyReceiptLog(truncated, { verifier, checkpoint })).toMatchObject({
      valid: false,
      kind: "truncated",
      seq: 2,
    });
    expect(await verifyReceiptLog(truncated, { verifier })).toMatchObject({ valid: true });
  });

  it("reports a log rewritten after the checkpoint was signed", async () => {
    const { entries, checkpoint } = await setup();
    // Rebuild the whole chain with a different receipt at seq 1, consistently.
    const rewritten: ReceiptLogEntry[] = [];
    let prevHash = RECEIPT_LOG_GENESIS_HASH;
    for (const entry of entries) {
      const swapped = entry.seq === 1 ? await receipt(77) : entry.receipt;
      const unhashed = { seq: entry.seq, prevHash, receipt: swapped, appendedAt: entry.appendedAt };
      const entryHash = await computeReceiptLogEntryHash(unhashed);
      rewritten.push({ ...unhashed, entryHash });
      prevHash = entryHash;
    }
    expect(await verifyReceiptLog(rewritten, { verifier })).toMatchObject({ valid: true });
    expect(await verifyReceiptLog(rewritten, { verifier, checkpoint })).toMatchObject({
      valid: false,
      kind: "checkpoint-mismatch",
      seq: 3,
    });
  });

  it("rejects a forged or mislabelled checkpoint", async () => {
    const { entries, checkpoint } = await setup();
    const forgedLog = await filledLog(4);
    const forged = await createReceiptLog({
      store: createMemoryReceiptLogStore(),
      logId: "log-main",
      verifier,
      signer: stranger,
    }).checkpoint();
    expect(await verifyReceiptLog(entries, { verifier, checkpoint: forged })).toMatchObject({
      kind: "invalid-checkpoint",
      seq: null,
    });
    expect(
      await verifyReceiptLog(entries, { verifier, checkpoint, logId: "another-log" }),
    ).toMatchObject({ kind: "invalid-checkpoint" });
    expect(await verifyReceiptLog(entries, { checkpoint })).toMatchObject({
      kind: "invalid-checkpoint",
    });
    expect((await forgedLog.read(0, 1)).length).toBe(1);
  });

  it("reports an entry that does not parse", async () => {
    const { entries } = await setup();
    expect(await verifyReceiptLog([entries[0], { seq: 1 }])).toMatchObject({
      kind: "malformed-entry",
      seq: 1,
    });
  });
});
