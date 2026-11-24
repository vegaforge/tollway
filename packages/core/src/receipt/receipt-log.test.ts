import { describe, expect, it } from "vitest";
import { buildReceipt, signReceipt } from "./receipt.js";
import {
  computeEntryHash,
  computeReceiptHash,
  createInMemoryReceiptLog,
  type ReceiptLogEntry,
  verifyReceiptLog,
  verifyReceiptLogCheckpoint,
} from "./receipt-log.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

const PAYER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const PAYEE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

async function makeSignedReceipt(signer: Ed25519Signer, id: string, txHash: string) {
  const body = buildReceipt({
    id,
    payer: PAYER,
    payee: PAYEE,
    amount: "1000",
    asset: ASSET,
    resource: "/api/weather",
    model: "x402",
    settlement: { kind: "transaction", txHash },
    network: "testnet",
    issuedAt: "2026-11-24T12:00:00.000Z",
  });
  return signReceipt(body, signer);
}

describe("hash-chained receipt log (#171)", () => {
  it("chains appended entries and verifies an untampered log", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const verifier = await Ed25519Verifier.fromPublicKey(signer.publicKey, signer.keyId);
    const log = createInMemoryReceiptLog({
      logId: "log-main",
      now: () => "2026-11-24T12:00:01.000Z",
    });

    const r0 = await makeSignedReceipt(signer, "r-0", "a".repeat(64));
    const r1 = await makeSignedReceipt(signer, "r-1", "b".repeat(64));
    const r2 = await makeSignedReceipt(signer, "r-2", "c".repeat(64));

    const e0 = await log.append(r0);
    const e1 = await log.append(r1);
    const e2 = await log.append(r2);

    expect(e0.index).toBe(0);
    expect(e0.prevHash).toBeNull();
    expect(e1.index).toBe(1);
    expect(e1.prevHash).toBe(e0.entryHash);
    expect(e2.index).toBe(2);
    expect(e2.prevHash).toBe(e1.entryHash);
    expect(await log.head()).toEqual(e2);
    expect(await log.get(1)).toEqual(e1);
    expect(await log.range(1, 2)).toEqual([e1, e2]);

    const cp = await log.checkpoint(signer);
    expect(cp.checkpoint.logId).toBe("log-main");
    expect(cp.checkpoint.headIndex).toBe(2);
    expect(cp.checkpoint.headHash).toBe(e2.entryHash);
    expect(cp.checkpoint.entryCount).toBe(3);

    const cpCheck = await verifyReceiptLogCheckpoint(cp, verifier, { expectedLogId: "log-main" });
    expect(cpCheck.valid).toBe(true);

    const verification = await verifyReceiptLog(await log.range(), {
      checkpoint: cp,
      checkpointVerifier: verifier,
      receiptVerifier: verifier,
      expectedLogId: "log-main",
    });
    expect(verification).toEqual({
      valid: true,
      entryCount: 3,
      headIndex: 2,
      headHash: e2.entryHash,
    });
  });

  it("emits periodic checkpoints automatically when checkpointInterval is set", async () => {
    const signer = await Ed25519Signer.generate("key-auto");
    const verifier = await Ed25519Verifier.fromPublicKey(signer.publicKey, signer.keyId);
    const log = createInMemoryReceiptLog({
      logId: "log-auto",
      checkpointInterval: 2,
      signer,
      now: () => "2026-11-24T12:00:00.000Z",
    });

    await log.append(await makeSignedReceipt(signer, "r-0", "0".repeat(64)));
    expect(await log.latestCheckpoint()).toBeUndefined();

    const e1 = await log.append(await makeSignedReceipt(signer, "r-1", "1".repeat(64)));
    const cp1 = await log.latestCheckpoint();
    expect(cp1?.checkpoint.headIndex).toBe(1);
    expect(cp1?.checkpoint.headHash).toBe(e1.entryHash);

    await log.append(await makeSignedReceipt(signer, "r-2", "2".repeat(64)));
    await log.append(await makeSignedReceipt(signer, "r-3", "3".repeat(64)));
    const allCheckpoints = await log.checkpoints();
    expect(allCheckpoints).toHaveLength(2);
    expect(allCheckpoints[1]!.checkpoint.entryCount).toBe(4);

    // Log grows past the first checkpoint and still verifies against it.
    const verification = await verifyReceiptLog(await log.range(), {
      checkpoint: allCheckpoints[0],
      checkpointVerifier: verifier,
    });
    expect(verification.valid).toBe(true);
  });

  it("detects receipt modification, deletion, and reordering", async () => {
    const signer = await Ed25519Signer.generate("key-tamper");
    const verifier = await Ed25519Verifier.fromPublicKey(signer.publicKey, signer.keyId);
    const log = createInMemoryReceiptLog({
      logId: "log-tamper",
      now: () => "2026-11-24T12:00:00.000Z",
    });

    const e0 = await log.append(await makeSignedReceipt(signer, "r-0", "a".repeat(64)));
    const e1 = await log.append(await makeSignedReceipt(signer, "r-1", "b".repeat(64)));
    const e2 = await log.append(await makeSignedReceipt(signer, "r-2", "c".repeat(64)));
    const cp = await log.checkpoint(signer);

    // 1. Modify a receipt in place without updating hashes.
    const modified: ReceiptLogEntry[] = [
      e0,
      {
        ...e1,
        receipt: {
          ...e1.receipt,
          receipt: { ...e1.receipt.receipt, amount: "9999" },
        },
      },
      e2,
    ];
    const modResult = await verifyReceiptLog(modified, {
      checkpoint: cp,
      checkpointVerifier: verifier,
    });
    expect(modResult.valid).toBe(false);
    if (!modResult.valid) expect(modResult.index).toBe(1);

    // 2. Delete a middle entry.
    const deletedMiddle = [e0, e2];
    const delMiddleResult = await verifyReceiptLog(deletedMiddle);
    expect(delMiddleResult.valid).toBe(false);

    // 3. Delete the tail entry against a checkpoint.
    const deletedTail = [e0, e1];
    const delTailResult = await verifyReceiptLog(deletedTail, {
      checkpoint: cp,
      checkpointVerifier: verifier,
    });
    expect(delTailResult.valid).toBe(false);

    // 4. Reorder entries and recompute hashes? Checkpoint still catches it.
    const swapped0 = {
      ...e0,
      receipt: e1.receipt,
      receiptHash: await computeReceiptHash(e1.receipt),
    };
    swapped0.entryHash = await computeEntryHash({
      index: 0,
      prevHash: null,
      receiptHash: swapped0.receiptHash,
      recordedAt: swapped0.recordedAt,
    });
    const swapped1 = {
      ...e1,
      prevHash: swapped0.entryHash,
      receipt: e0.receipt,
      receiptHash: await computeReceiptHash(e0.receipt),
    };
    swapped1.entryHash = await computeEntryHash({
      index: 1,
      prevHash: swapped1.prevHash,
      receiptHash: swapped1.receiptHash,
      recordedAt: swapped1.recordedAt,
    });
    const swapped2 = {
      ...e2,
      prevHash: swapped1.entryHash,
    };
    swapped2.entryHash = await computeEntryHash({
      index: 2,
      prevHash: swapped2.prevHash,
      receiptHash: swapped2.receiptHash,
      recordedAt: swapped2.recordedAt,
    });
    const reorderedResult = await verifyReceiptLog([swapped0, swapped1, swapped2], {
      checkpoint: cp,
      checkpointVerifier: verifier,
    });
    expect(reorderedResult.valid).toBe(false);
    if (!reorderedResult.valid) expect(reorderedResult.index).toBe(2);
  });

  it("rejects forged checkpoints and mismatched logIds", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const attacker = await Ed25519Signer.generate("key-1");
    const verifier = await Ed25519Verifier.fromPublicKey(signer.publicKey, signer.keyId);

    const log = createInMemoryReceiptLog({ logId: "log-a" });
    await log.append(await makeSignedReceipt(signer, "r-0", "a".repeat(64)));
    const validCp = await log.checkpoint(signer);
    const forgedCp = await log.checkpoint(attacker);

    const wrongLogId = await verifyReceiptLog(await log.range(), {
      checkpoint: validCp,
      checkpointVerifier: verifier,
      expectedLogId: "log-b",
    });
    expect(wrongLogId.valid).toBe(false);

    const forgedResult = await verifyReceiptLog(await log.range(), {
      checkpoint: forgedCp,
      checkpointVerifier: verifier,
    });
    expect(forgedResult.valid).toBe(false);
  });
});
