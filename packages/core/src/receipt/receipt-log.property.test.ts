import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { buildReceipt, signReceipt } from "./receipt.js";
import {
  createMemoryReceiptLogStore,
  createReceiptLog,
  type ReceiptLogEntry,
  type ReceiptLogFailureKind,
  type SignedReceiptLogCheckpoint,
  verifyReceiptLog,
} from "./receipt-log.js";
import type { SignedReceipt } from "./schema.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

/** Pinned seed so a CI failure replays exactly, as in receipt.property.test.ts. */
const ASSERT_OPTS = { seed: 0x171c4a1, numRuns: 100 };
const MAX_ENTRIES = 12;

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;
let pool: SignedReceipt[];

beforeAll(async () => {
  signer = await Ed25519Signer.generate("property-log-key");
  verifier = Ed25519Verifier.forSigner(signer);
  // Signing is the slow part, so the receipts are made once and reused.
  pool = await Promise.all(
    Array.from({ length: MAX_ENTRIES }, (_, n) =>
      signReceipt(
        buildReceipt({
          id: `prop-${n}`,
          payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          payee: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
          amount: String(n + 1),
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          resource: `/r/${n}`,
          model: "x402",
          settlement: { kind: "transaction", txHash: n.toString(16).padStart(64, "0") },
          network: "testnet",
          issuedAt: "2026-11-24T12:00:00.000Z",
        }),
        signer,
      ),
    ),
  );
});

async function buildLog(
  size: number,
): Promise<{ entries: ReceiptLogEntry[]; checkpoint: SignedReceiptLogCheckpoint }> {
  let tick = Date.parse("2026-11-24T12:00:01.000Z");
  const log = createReceiptLog({
    store: createMemoryReceiptLogStore(),
    logId: "property-log",
    verifier,
    signer,
    now: () => tick++,
  });
  for (const receipt of pool.slice(0, size)) {
    await log.append(receipt);
  }
  return { entries: await log.read(0, MAX_ENTRIES), checkpoint: await log.checkpoint() };
}

/** Index into a list in a test, failing loudly instead of asserting non-null. */
function entryAt(list: ReceiptLogEntry[], index: number): ReceiptLogEntry {
  const entry = list[index];
  if (!entry) throw new Error(`no entry at ${index}`);
  return entry;
}

type Mutation =
  | { kind: "edit"; at: number }
  | { kind: "delete"; at: number }
  | { kind: "swap"; at: number }
  | { kind: "truncate"; keep: number };

/** A log size and one mutation that is valid for that size. */
const caseArb = fc.integer({ min: 2, max: MAX_ENTRIES }).chain((size) =>
  fc.tuple(
    fc.constant(size),
    fc.oneof(
      fc.integer({ min: 0, max: size - 1 }).map((at): Mutation => ({ kind: "edit", at })),
      fc.integer({ min: 0, max: size - 1 }).map((at): Mutation => ({ kind: "delete", at })),
      fc.integer({ min: 0, max: size - 2 }).map((at): Mutation => ({ kind: "swap", at })),
      fc.integer({ min: 0, max: size - 1 }).map((keep): Mutation => ({ kind: "truncate", keep })),
    ),
  ),
);

/** Applies a mutation and returns the failure kind and seq a verifier must report. */
function mutate(
  entries: ReceiptLogEntry[],
  mutation: Mutation,
): { mutated: ReceiptLogEntry[]; kind: ReceiptLogFailureKind; seq: number } {
  const copy = structuredClone(entries);
  switch (mutation.kind) {
    case "edit": {
      const target = entryAt(copy, mutation.at);
      target.receipt.receipt.amount = `${target.receipt.receipt.amount}0`;
      return { mutated: copy, kind: "modified-entry", seq: mutation.at };
    }
    case "delete": {
      copy.splice(mutation.at, 1);
      // Deleting the last entry leaves a consistent prefix: only the checkpoint sees it.
      return mutation.at === entries.length - 1
        ? { mutated: copy, kind: "truncated", seq: mutation.at }
        : { mutated: copy, kind: "gap-or-reorder", seq: mutation.at };
    }
    case "swap": {
      const a = entryAt(copy, mutation.at);
      copy[mutation.at] = entryAt(copy, mutation.at + 1);
      copy[mutation.at + 1] = a;
      return { mutated: copy, kind: "gap-or-reorder", seq: mutation.at };
    }
    case "truncate":
      return { mutated: copy.slice(0, mutation.keep), kind: "truncated", seq: mutation.keep };
  }
}

describe("receipt log verification (property)", () => {
  it("always accepts an unmutated log against its checkpoint", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: MAX_ENTRIES }), async (size) => {
        const { entries, checkpoint } = await buildLog(size);
        const result = await verifyReceiptLog(entries, { verifier, checkpoint });
        expect(result).toMatchObject({ valid: true, size });
      }),
      ASSERT_OPTS,
    );
  });

  it("reports any single edit, delete, swap or truncation at the right seq", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ([size, mutation]) => {
        const { entries, checkpoint } = await buildLog(size);
        const { mutated, kind, seq } = mutate(entries, mutation);
        const result = await verifyReceiptLog(mutated, { verifier, checkpoint });
        expect(result).toMatchObject({ valid: false, kind, seq });
      }),
      ASSERT_OPTS,
    );
  });
});
