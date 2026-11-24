/**
 * Hash-chained receipt log with signed checkpoints (#171).
 *
 * Every entry commits to the one before it by SHA-256, and a checkpoint signs
 * the size and head hash of the log at a moment in time. Anyone holding the
 * entries and a trusted checkpoint can check that no receipt covered by the
 * checkpoint was modified, removed or reordered.
 *
 * This module is the format, the verifier and the append logic. Storage sits
 * behind {@link ReceiptLogStore}: the in-memory store lives here, and the
 * JSON Lines file store lives in `@vegaforge/tollway-observability`, so this
 * package never touches `node:fs`. See docs/receipt-log.md.
 */

import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import { verifyReceipt } from "./receipt.js";
import { receiptSignatureSchema, signedReceiptSchema } from "./schema.js";
import type { ReceiptSigner, ReceiptVerifier, SignatureCheck } from "./signer.js";

/** A SHA-256 digest as 64 lowercase hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The `prevHash` of entry 0. A fixed value rather than `null`, so every entry
 * has the same shape and the hash input never changes type.
 */
export const RECEIPT_LOG_GENESIS_HASH = "0".repeat(64);

/** The `type` tag on a checkpoint body, so its signature can never be read as a receipt's. */
export const RECEIPT_LOG_CHECKPOINT_TYPE = "tollway-receipt-log-checkpoint";

const sha256HexSchema = z.string().regex(SHA256_HEX, "expected a lowercase hex SHA-256 digest");

/**
 * One log entry. `entryHash` is the SHA-256 of the canonical bytes (#165) of
 * `{ seq, prevHash, receipt, appendedAt }`, and `prevHash` is the previous
 * entry's `entryHash`, or {@link RECEIPT_LOG_GENESIS_HASH} for `seq` 0.
 */
export const receiptLogEntrySchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  prevHash: sha256HexSchema,
  receipt: signedReceiptSchema,
  appendedAt: z.iso.datetime(),
  entryHash: sha256HexSchema,
});

export type ReceiptLogEntry = z.infer<typeof receiptLogEntrySchema>;

/**
 * The signed part of a checkpoint. `size` is the number of entries the
 * checkpoint covers and `headHash` is the `entryHash` of entry `size - 1`
 * (the genesis hash when `size` is 0). `logId` names the log so checkpoints
 * of two logs are not mixed up; it is not part of any entry.
 */
export const receiptLogCheckpointSchema = z.strictObject({
  type: z.literal(RECEIPT_LOG_CHECKPOINT_TYPE),
  version: z.literal(1),
  logId: z.string().min(1),
  size: z.number().int().nonnegative(),
  headHash: sha256HexSchema,
  issuedAt: z.iso.datetime(),
});

export type ReceiptLogCheckpoint = z.infer<typeof receiptLogCheckpointSchema>;

/** A checkpoint and the signature over its canonical bytes. */
export const signedReceiptLogCheckpointSchema = z.strictObject({
  checkpoint: receiptLogCheckpointSchema,
  signature: receiptSignatureSchema,
});

export type SignedReceiptLogCheckpoint = z.infer<typeof signedReceiptLogCheckpointSchema>;

/** The head of a log: how many entries it holds and the last `entryHash`. */
export type ReceiptLogHead = {
  size: number;
  headHash: string;
};

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/** Computes `entryHash` for an entry: SHA-256 over the canonical bytes of every field but `entryHash`. */
export async function computeReceiptLogEntryHash(
  entry: Omit<ReceiptLogEntry, "entryHash">,
): Promise<string> {
  const unhashed = {
    seq: entry.seq,
    prevHash: entry.prevHash,
    receipt: entry.receipt,
    appendedAt: entry.appendedAt,
  };
  return sha256Hex(canonicalBytes(unhashed as unknown as JsonValue));
}

/** Signs a checkpoint with any {@link ReceiptSigner}, the same way receipts are signed. */
export async function signReceiptLogCheckpoint(
  checkpoint: ReceiptLogCheckpoint,
  signer: ReceiptSigner,
): Promise<SignedReceiptLogCheckpoint> {
  const body = receiptLogCheckpointSchema.parse(checkpoint);
  const signature = await signer.sign(canonicalBytes(body as unknown as JsonValue));
  return {
    checkpoint: body,
    signature: {
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      value: bytesToBase64Url(signature),
    },
  };
}

/** The result of {@link verifyReceiptLogCheckpoint}. */
export type ReceiptLogCheckpointVerification =
  | { valid: true; checkpoint: SignedReceiptLogCheckpoint }
  | { valid: false; reason: string };

/**
 * Checks a checkpoint's shape and signature. Takes `unknown` because a
 * checkpoint usually comes from outside the log (a webhook, a published
 * file), and never throws.
 */
export async function verifyReceiptLogCheckpoint(
  candidate: unknown,
  verifier: ReceiptVerifier,
  options: { logId?: string } = {},
): Promise<ReceiptLogCheckpointVerification> {
  const parsed = signedReceiptLogCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    return { valid: false, reason: describeIssues(parsed.error.issues) };
  }
  const { checkpoint, signature } = parsed.data;
  if (options.logId !== undefined && checkpoint.logId !== options.logId) {
    return {
      valid: false,
      reason: `checkpoint is for log "${checkpoint.logId}", expected "${options.logId}"`,
    };
  }
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature.value);
  } catch {
    return { valid: false, reason: "signature.value is not base64url" };
  }
  const check = await checkSignature(verifier, {
    message: canonicalBytes(checkpoint as unknown as JsonValue),
    signature: signatureBytes,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
  });
  if (!check.valid) {
    return check;
  }
  return { valid: true, checkpoint: parsed.data };
}

/**
 * Why a log failed verification. `seq` in the failure is the first entry
 * position at fault.
 *
 * - `malformed-entry`: the entry does not parse as a log entry.
 * - `gap-or-reorder`: the entry at position `n` does not carry `seq` `n`.
 * - `broken-link`: `prevHash` is not the previous entry's `entryHash`.
 * - `modified-entry`: `entryHash` does not match the entry's contents.
 * - `receipt-signature`: the receipt's own signature does not verify.
 * - `truncated`: the log is shorter than the checkpoint says it was.
 * - `checkpoint-mismatch`: the entry the checkpoint names has another hash,
 *   so the log was rewritten after the checkpoint was signed.
 * - `invalid-checkpoint`: the checkpoint itself does not verify (`seq` is null).
 */
export type ReceiptLogFailureKind =
  | "malformed-entry"
  | "gap-or-reorder"
  | "broken-link"
  | "modified-entry"
  | "receipt-signature"
  | "truncated"
  | "checkpoint-mismatch"
  | "invalid-checkpoint";

/** The result of {@link verifyReceiptLog}. */
export type ReceiptLogVerification =
  | { valid: true; size: number; headHash: string }
  | { valid: false; kind: ReceiptLogFailureKind; seq: number | null; reason: string };

/** Options for {@link verifyReceiptLog}. */
export type VerifyReceiptLogOptions = {
  /**
   * Checks every receipt's own signature. Without it only the chain is
   * checked, which proves the log is internally consistent but not that the
   * receipts came from a trusted key.
   */
  verifier?: ReceiptVerifier;
  /** A checkpoint held outside the log. Without one, tail truncation cannot be detected. */
  checkpoint?: unknown;
  /** Verifies the checkpoint's signature. Defaults to `verifier`. */
  checkpointVerifier?: ReceiptVerifier;
  /** When set, the checkpoint must name this log. */
  logId?: string;
};

/**
 * Verifies a log from entry 0. It reports the first failing `seq` and why;
 * see {@link ReceiptLogFailureKind}. A receipt is checked against the time it
 * was appended, so a v2 receipt that has expired since is still valid in the
 * log. Never throws.
 */
export async function verifyReceiptLog(
  entries: readonly unknown[],
  options: VerifyReceiptLogOptions = {},
): Promise<ReceiptLogVerification> {
  let anchor: ReceiptLogCheckpoint | undefined;
  if (options.checkpoint !== undefined) {
    const checkpointVerifier = options.checkpointVerifier ?? options.verifier;
    if (!checkpointVerifier) {
      return {
        valid: false,
        kind: "invalid-checkpoint",
        seq: null,
        reason: "a checkpoint was given without a verifier for its signature",
      };
    }
    const verified = await verifyReceiptLogCheckpoint(options.checkpoint, checkpointVerifier, {
      ...(options.logId !== undefined ? { logId: options.logId } : {}),
    });
    if (!verified.valid) {
      return { valid: false, kind: "invalid-checkpoint", seq: null, reason: verified.reason };
    }
    anchor = verified.checkpoint.checkpoint;
  }

  const hashes: string[] = [];
  let prevHash = RECEIPT_LOG_GENESIS_HASH;
  for (let position = 0; position < entries.length; position += 1) {
    const parsed = receiptLogEntrySchema.safeParse(entries[position]);
    if (!parsed.success) {
      return fail("malformed-entry", position, describeIssues(parsed.error.issues));
    }
    const entry = parsed.data;
    if (entry.seq !== position) {
      return fail("gap-or-reorder", position, `entry at position ${position} has seq ${entry.seq}`);
    }
    if (entry.prevHash !== prevHash) {
      return fail(
        "broken-link",
        position,
        `prevHash does not match the entryHash of seq ${position - 1}`,
      );
    }
    if ((await computeReceiptLogEntryHash(entry)) !== entry.entryHash) {
      return fail("modified-entry", position, "entryHash does not match the entry's contents");
    }
    if (options.verifier) {
      const receiptCheck = await verifyReceipt(entry.receipt, options.verifier, {
        now: Date.parse(entry.appendedAt),
      });
      if (!receiptCheck.valid) {
        return fail("receipt-signature", position, receiptCheck.reason);
      }
    }
    hashes.push(entry.entryHash);
    prevHash = entry.entryHash;
  }

  if (anchor) {
    if (entries.length < anchor.size) {
      return fail(
        "truncated",
        entries.length,
        `log has ${entries.length} entries; the checkpoint covers ${anchor.size}`,
      );
    }
    const anchoredHash = anchor.size === 0 ? RECEIPT_LOG_GENESIS_HASH : hashes[anchor.size - 1];
    if (anchoredHash !== anchor.headHash) {
      return fail(
        "checkpoint-mismatch",
        anchor.size === 0 ? null : anchor.size - 1,
        "the log does not match the checkpoint's headHash",
      );
    }
  }

  return { valid: true, size: entries.length, headHash: prevHash };
}

function fail(
  kind: ReceiptLogFailureKind,
  seq: number | null,
  reason: string,
): ReceiptLogVerification {
  return { valid: false, kind, seq, reason };
}

/**
 * Where a {@link ReceiptLog} keeps its entries. The log serialises its own
 * appends, so a store only needs to be safe for a single writer. `append`
 * must still refuse an entry whose `seq` is not the current size or whose
 * `prevHash` is not the current head hash: that compare-and-set is what keeps
 * the chain from forking if two writers ever share a store. A store for
 * several processes has to make that check atomic in the backing system.
 */
export interface ReceiptLogStore {
  head(): Promise<ReceiptLogHead>;
  /** Durably stores `entry`, or throws `receipt-log-conflict` when it does not extend the head. */
  append(entry: ReceiptLogEntry): Promise<void>;
  /** Up to `limit` entries starting at `fromSeq`, in order. */
  read(fromSeq: number, limit: number): Promise<ReceiptLogEntry[]>;
}

/**
 * Throws `receipt-log-conflict` unless `entry` extends `head`. Stores call it
 * before writing.
 */
export function assertExtendsHead(head: ReceiptLogHead, entry: ReceiptLogEntry): void {
  if (entry.seq !== head.size || entry.prevHash !== head.headHash) {
    throw new TollwayError(
      "receipt-log-conflict",
      `entry seq ${entry.seq} does not extend the log head (size ${head.size})`,
    );
  }
}

/** Checks the `fromSeq` and `limit` arguments of {@link ReceiptLogStore.read}. */
export function assertReadRange(fromSeq: number, limit: number): void {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new RangeError(`fromSeq must be a non-negative integer, got ${fromSeq}`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
}

/** An in-memory {@link ReceiptLogStore}. Entries are lost when the process exits. */
export function createMemoryReceiptLogStore(): ReceiptLogStore {
  const entries: ReceiptLogEntry[] = [];
  const head = (): ReceiptLogHead => ({
    size: entries.length,
    headHash: entries.at(-1)?.entryHash ?? RECEIPT_LOG_GENESIS_HASH,
  });
  return {
    async head() {
      return head();
    },
    async append(entry) {
      assertExtendsHead(head(), entry);
      entries.push(entry);
    },
    async read(fromSeq, limit) {
      assertReadRange(fromSeq, limit);
      return entries.slice(fromSeq, fromSeq + limit);
    },
  };
}

/** When {@link createReceiptLog} signs checkpoints by itself. */
export type ReceiptLogCheckpointSchedule =
  | { checkpointEvery?: undefined; onCheckpointError?: undefined }
  | {
      /** Signs a checkpoint after every `checkpointEvery` appends. Needs `signer`. */
      checkpointEvery: number;
      /**
       * Receives a failure to sign or deliver an automatic checkpoint. The
       * entry that triggered it is already stored, so the append itself
       * still resolves; the next scheduled checkpoint covers it.
       */
      onCheckpointError: (error: unknown, size: number) => void;
    };

/** Options for {@link createReceiptLog}. */
export type ReceiptLogOptions = {
  store: ReceiptLogStore;
  /** Names the log in its checkpoints. */
  logId: string;
  /** Every receipt is checked with this before it is written. */
  verifier: ReceiptVerifier;
  /** Signs checkpoints. Required for {@link ReceiptLog.checkpoint} and `checkpointEvery`. */
  signer?: ReceiptSigner;
  /**
   * Called with every new checkpoint. Use it to send the checkpoint somewhere
   * the log's operator cannot rewrite, such as a webhook or a published file.
   */
  onCheckpoint?: (checkpoint: SignedReceiptLogCheckpoint) => void | Promise<void>;
  /** Clock in ms, for `appendedAt` and `issuedAt`. Defaults to `Date.now`. */
  now?: () => number;
} & ReceiptLogCheckpointSchedule;

/** An append-only, hash-chained receipt log. */
export interface ReceiptLog {
  readonly logId: string;
  /**
   * Verifies the receipt's signature, then appends it. Concurrent calls are
   * queued, so each one extends the entry the previous one wrote. Throws
   * `receipt-verification-failed` for a receipt that does not verify.
   */
  append(receipt: unknown): Promise<ReceiptLogEntry>;
  head(): Promise<ReceiptLogHead>;
  /** Up to `limit` entries starting at `fromSeq`, in order. */
  read(fromSeq: number, limit: number): Promise<ReceiptLogEntry[]>;
  /** Signs a checkpoint of the current head now. Throws `invalid-signing-key` without a signer. */
  checkpoint(): Promise<SignedReceiptLogCheckpoint>;
  /** The newest checkpoint this instance signed, if any. Not persisted. */
  latestCheckpoint(): SignedReceiptLogCheckpoint | undefined;
}

/**
 * Builds a {@link ReceiptLog} over a store. Writes go through one queue, so
 * the log is safe for concurrent callers in one process. Run one writer per
 * log: two processes over the same store are only safe when the store's
 * `append` is an atomic compare-and-set.
 */
export function createReceiptLog(options: ReceiptLogOptions): ReceiptLog {
  if (options.logId.length === 0) {
    throw new TypeError("logId must not be empty");
  }
  const { checkpointEvery } = options;
  if (checkpointEvery !== undefined) {
    if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 1) {
      throw new RangeError(`checkpointEvery must be a positive integer, got ${checkpointEvery}`);
    }
    if (!options.signer) {
      throw new TypeError("checkpointEvery needs a signer");
    }
  }
  const now = options.now ?? Date.now;
  let latest: SignedReceiptLogCheckpoint | undefined;
  // Every operation that reads the head and acts on it runs on this chain,
  // so two appends can never compute the same seq.
  let queue: Promise<unknown> = Promise.resolve();

  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    // Keep the queue alive after a failure; the caller still gets the rejection.
    queue = run.catch(() => undefined);
    return run;
  }

  async function signHead(head: ReceiptLogHead): Promise<SignedReceiptLogCheckpoint> {
    if (!options.signer) {
      throw new TollwayError(
        "invalid-signing-key",
        "the receipt log has no signer for checkpoints",
      );
    }
    const signed = await signReceiptLogCheckpoint(
      {
        type: RECEIPT_LOG_CHECKPOINT_TYPE,
        version: 1,
        logId: options.logId,
        size: head.size,
        headHash: head.headHash,
        issuedAt: new Date(now()).toISOString(),
      },
      options.signer,
    );
    latest = signed;
    await options.onCheckpoint?.(signed);
    return signed;
  }

  return {
    logId: options.logId,
    append(receipt) {
      return serialised(async () => {
        const appendedAtMs = now();
        const verified = await verifyReceipt(receipt, options.verifier, { now: appendedAtMs });
        if (!verified.valid) {
          throw new TollwayError(
            "receipt-verification-failed",
            `receipt not appended: ${verified.reason}`,
          );
        }
        const head = await options.store.head();
        const unhashed = {
          seq: head.size,
          prevHash: head.headHash,
          receipt: verified.receipt,
          appendedAt: new Date(appendedAtMs).toISOString(),
        };
        const entry: ReceiptLogEntry = {
          ...unhashed,
          entryHash: await computeReceiptLogEntryHash(unhashed),
        };
        await options.store.append(entry);
        const size = entry.seq + 1;
        if (checkpointEvery !== undefined && size % checkpointEvery === 0) {
          try {
            await signHead({ size, headHash: entry.entryHash });
          } catch (error) {
            options.onCheckpointError?.(error, size);
          }
        }
        return entry;
      });
    },
    head() {
      return serialised(() => options.store.head());
    },
    async read(fromSeq, limit) {
      assertReadRange(fromSeq, limit);
      return options.store.read(fromSeq, limit);
    },
    checkpoint() {
      return serialised(async () => signHead(await options.store.head()));
    },
    latestCheckpoint() {
      return latest;
    },
  };
}

async function checkSignature(
  verifier: ReceiptVerifier,
  input: Parameters<ReceiptVerifier["verify"]>[0],
): Promise<SignatureCheck> {
  try {
    if (verifier.check) {
      return await verifier.check(input);
    }
    return (await verifier.verify(input))
      ? { valid: true }
      : { valid: false, reason: "signature does not verify against any trusted key" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `the verifier failed: ${message}` };
  }
}

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}
