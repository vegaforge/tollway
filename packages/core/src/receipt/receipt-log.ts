import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import { verifyReceipt } from "./receipt.js";
import {
  receiptSignatureSchema,
  type SignedReceipt,
  signedReceiptSchema,
} from "./schema.js";
import type { ReceiptSigner, ReceiptVerifier } from "./signer.js";

/**
 * Tamper-evident, hash-chained receipt log with signed checkpoints (#171).
 *
 * Every entry commits to the previous entry by SHA-256 hash over its
 * canonical bytes, and periodic signed checkpoints commit to the head of the
 * chain. Anyone holding the log and a trusted checkpoint can verify that no
 * receipt was modified, removed, or reordered.
 */

const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

const sha256Base64UrlSchema = z
  .string()
  .regex(BASE64URL_SHA256, "expected base64url-encoded 32-byte SHA-256 digest");

/**
 * One entry in the append-only receipt log. `prevHash` is `null` for the
 * genesis entry (`index === 0`) and equals `entry[index - 1].entryHash` for
 * every subsequent entry.
 */
export const receiptLogEntrySchema = z
  .strictObject({
    index: z.number().int().nonnegative(),
    prevHash: sha256Base64UrlSchema.nullable(),
    receipt: signedReceiptSchema,
    receiptHash: sha256Base64UrlSchema,
    entryHash: sha256Base64UrlSchema,
    recordedAt: z.iso.datetime(),
  })
  .superRefine((entry, ctx) => {
    if (entry.index === 0 && entry.prevHash !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["prevHash"],
        message: "genesis entry (index 0) must have prevHash === null",
      });
    }
    if (entry.index > 0 && entry.prevHash === null) {
      ctx.addIssue({
        code: "custom",
        path: ["prevHash"],
        message: "non-genesis entry (index > 0) must have a non-null prevHash",
      });
    }
  });

/** One entry in a hash-chained receipt log; see {@link receiptLogEntrySchema}. */
export type ReceiptLogEntry = z.infer<typeof receiptLogEntrySchema>;

/** The signed body of a receipt log checkpoint. */
export const receiptLogCheckpointBodySchema = z
  .strictObject({
    version: z.literal(1),
    logId: z.string().min(1),
    headIndex: z.number().int().nonnegative(),
    headHash: sha256Base64UrlSchema,
    entryCount: z.number().int().positive(),
    issuedAt: z.iso.datetime(),
  })
  .superRefine((body, ctx) => {
    if (body.entryCount !== body.headIndex + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["entryCount"],
        message: `entryCount (${body.entryCount}) must equal headIndex + 1 (${body.headIndex + 1})`,
      });
    }
  });

/** The unsigned checkpoint payload; see {@link receiptLogCheckpointBodySchema}. */
export type ReceiptLogCheckpointBody = z.infer<typeof receiptLogCheckpointBodySchema>;

/** A checkpoint signed with the service's {@link ReceiptSigner}. */
export const signedReceiptLogCheckpointSchema = z.strictObject({
  checkpoint: receiptLogCheckpointBodySchema,
  signature: receiptSignatureSchema,
});

/** A signed receipt log checkpoint; see {@link signedReceiptLogCheckpointSchema}. */
export type SignedReceiptLogCheckpoint = z.infer<typeof signedReceiptLogCheckpointSchema>;

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return bytesToBase64Url(digest);
}

/**
 * Computes the canonical SHA-256 digest (base64url) of a {@link SignedReceipt}.
 */
export async function computeReceiptHash(receipt: SignedReceipt): Promise<string> {
  return sha256Base64Url(canonicalBytes(receipt as unknown as JsonValue));
}

/**
 * Computes the canonical SHA-256 digest (base64url) of a log entry's
 * commitment fields (`index`, `prevHash`, `receiptHash`, `recordedAt`).
 */
export async function computeEntryHash(input: {
  index: number;
  prevHash: string | null;
  receiptHash: string;
  recordedAt: string;
}): Promise<string> {
  const payload: JsonValue = {
    index: input.index,
    prevHash: input.prevHash,
    receiptHash: input.receiptHash,
    recordedAt: input.recordedAt,
  };
  return sha256Base64Url(canonicalBytes(payload));
}

/**
 * Signs a receipt log checkpoint body using {@link ReceiptSigner}.
 */
export async function signReceiptLogCheckpoint(
  body: ReceiptLogCheckpointBody,
  signer: ReceiptSigner,
): Promise<SignedReceiptLogCheckpoint> {
  const checkpoint = receiptLogCheckpointBodySchema.parse(body);
  const signature = await signer.sign(canonicalBytes(checkpoint as unknown as JsonValue));
  return {
    checkpoint,
    signature: {
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      value: bytesToBase64Url(signature),
    },
  };
}

/** Outcome of {@link verifyReceiptLogCheckpoint}. */
export type CheckpointVerification =
  | { valid: true; checkpoint: SignedReceiptLogCheckpoint }
  | { valid: false; reason: string };

/**
 * Verifies a signed receipt log checkpoint's schema, optional `expectedLogId`,
 * and cryptographic signature against `verifier`.
 */
export async function verifyReceiptLogCheckpoint(
  candidate: unknown,
  verifier: ReceiptVerifier,
  options: { expectedLogId?: string } = {},
): Promise<CheckpointVerification> {
  const parsed = signedReceiptLogCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      valid: false,
      reason: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "),
    };
  }
  const { checkpoint, signature } = parsed.data;
  if (options.expectedLogId !== undefined && checkpoint.logId !== options.expectedLogId) {
    return {
      valid: false,
      reason: `checkpoint logId "${checkpoint.logId}" does not match expected "${options.expectedLogId}"`,
    };
  }
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature.value);
  } catch {
    return { valid: false, reason: "checkpoint signature value is not valid base64url" };
  }
  const message = canonicalBytes(checkpoint as unknown as JsonValue);
  const input = {
    message,
    signature: signatureBytes,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
  };
  if (verifier.check) {
    const check = await verifier.check(input);
    if (!check.valid) {
      return { valid: false, reason: check.reason };
    }
  } else {
    const ok = await verifier.verify(input);
    if (!ok) {
      return { valid: false, reason: "checkpoint signature verification failed" };
    }
  }
  return { valid: true, checkpoint: parsed.data };
}

/** Options for {@link verifyReceiptLog}. */
export type VerifyReceiptLogOptions = {
  /** Optional signed checkpoint the log must be consistent with. */
  checkpoint?: unknown;
  /** Verifier for `checkpoint`. Required whenever `checkpoint` is provided. */
  checkpointVerifier?: ReceiptVerifier;
  /** Optional verifier to also check each receipt's own signature. */
  receiptVerifier?: ReceiptVerifier;
  /** Expected `logId` on `checkpoint`. */
  expectedLogId?: string;
  /** Current time in ms for v2 receipt expiry checks when `receiptVerifier` is set. */
  now?: number;
};

/** Outcome of {@link verifyReceiptLog}. */
export type ReceiptLogVerification =
  | {
      valid: true;
      entryCount: number;
      headIndex: number | null;
      headHash: string | null;
    }
  | {
      valid: false;
      reason: string;
      /** Index of the entry where verification failed, when applicable. */
      index?: number;
    };

/**
 * Verifies the integrity of a hash-chained receipt log from genesis (`index 0`).
 *
 * Checks every entry's schema, sequential indexing, `prevHash` linkage,
 * `receiptHash`, and `entryHash`. When `receiptVerifier` is supplied, each
 * receipt's own signature is verified as well. When `checkpoint` is supplied,
 * the checkpoint signature is verified and the entry at `checkpoint.headIndex`
 * must match `checkpoint.headHash`, proving no prefix entry was modified,
 * deleted, or reordered.
 */
export async function verifyReceiptLog(
  entries: readonly unknown[],
  options: VerifyReceiptLogOptions = {},
): Promise<ReceiptLogVerification> {
  if (options.checkpoint !== undefined && !options.checkpointVerifier) {
    return {
      valid: false,
      reason: "checkpointVerifier is required when verifying against a checkpoint",
    };
  }

  let verifiedCheckpoint: SignedReceiptLogCheckpoint | undefined;
  if (options.checkpoint !== undefined && options.checkpointVerifier) {
    const cp = await verifyReceiptLogCheckpoint(options.checkpoint, options.checkpointVerifier, {
      expectedLogId: options.expectedLogId,
    });
    if (!cp.valid) {
      return { valid: false, reason: `invalid checkpoint: ${cp.reason}` };
    }
    verifiedCheckpoint = cp.checkpoint;
  }

  if (entries.length === 0) {
    if (verifiedCheckpoint) {
      return {
        valid: false,
        reason: `log is empty but checkpoint commits to ${verifiedCheckpoint.checkpoint.entryCount} entries`,
      };
    }
    return { valid: true, entryCount: 0, headIndex: null, headHash: null };
  }

  let prevEntryHash: string | null = null;
  const parsedEntries: ReceiptLogEntry[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const parsed = receiptLogEntrySchema.safeParse(entries[i]);
    if (!parsed.success) {
      return {
        valid: false,
        index: i,
        reason: `entry ${i} failed schema validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }
    const entry = parsed.data;
    if (entry.index !== i) {
      return {
        valid: false,
        index: i,
        reason: `expected entry index ${i}, got ${entry.index}`,
      };
    }
    if (i === 0 && entry.prevHash !== null) {
      return {
        valid: false,
        index: i,
        reason: "genesis entry must have prevHash === null",
      };
    }
    if (i > 0 && entry.prevHash !== prevEntryHash) {
      return {
        valid: false,
        index: i,
        reason: `entry ${i} prevHash does not match entry ${i - 1} entryHash`,
      };
    }

    const expectedReceiptHash = await computeReceiptHash(entry.receipt);
    if (entry.receiptHash !== expectedReceiptHash) {
      return {
        valid: false,
        index: i,
        reason: `entry ${i} receiptHash does not match receipt contents`,
      };
    }

    const expectedEntryHash = await computeEntryHash({
      index: entry.index,
      prevHash: entry.prevHash,
      receiptHash: entry.receiptHash,
      recordedAt: entry.recordedAt,
    });
    if (entry.entryHash !== expectedEntryHash) {
      return {
        valid: false,
        index: i,
        reason: `entry ${i} entryHash does not match entry commitment`,
      };
    }

    if (options.receiptVerifier) {
      const receiptCheck = await verifyReceipt(entry.receipt, options.receiptVerifier, {
        now: options.now,
      });
      if (!receiptCheck.valid) {
        return {
          valid: false,
          index: i,
          reason: `entry ${i} receipt signature invalid: ${receiptCheck.reason}`,
        };
      }
    }

    prevEntryHash = entry.entryHash;
    parsedEntries.push(entry);
  }

  if (verifiedCheckpoint) {
    const { headIndex, headHash, entryCount } = verifiedCheckpoint.checkpoint;
    if (parsedEntries.length < entryCount) {
      return {
        valid: false,
        reason: `log has ${parsedEntries.length} entries, fewer than checkpoint entryCount ${entryCount}`,
      };
    }
    const anchored = parsedEntries[headIndex];
    if (!anchored || anchored.entryHash !== headHash) {
      return {
        valid: false,
        index: headIndex,
        reason: `entry ${headIndex} entryHash does not match checkpoint headHash`,
      };
    }
  }

  const head = parsedEntries[parsedEntries.length - 1]!;
  return {
    valid: true,
    entryCount: parsedEntries.length,
    headIndex: head.index,
    headHash: head.entryHash,
  };
}

/** Append-only hash-chained receipt log interface. */
export interface ReceiptLog {
  readonly logId: string;
  append(receipt: SignedReceipt, options?: { recordedAt?: string }): Promise<ReceiptLogEntry>;
  head(): Promise<ReceiptLogEntry | undefined>;
  get(index: number): Promise<ReceiptLogEntry | undefined>;
  range(fromIndex?: number, toIndex?: number): Promise<readonly ReceiptLogEntry[]>;
  checkpoint(signer: ReceiptSigner, options?: { issuedAt?: string }): Promise<SignedReceiptLogCheckpoint>;
  latestCheckpoint(): Promise<SignedReceiptLogCheckpoint | undefined>;
  checkpoints(): Promise<readonly SignedReceiptLogCheckpoint[]>;
}

/** Options for {@link createInMemoryReceiptLog}. */
export type InMemoryReceiptLogOptions = {
  /** Stable identifier for this log. Defaults to a fresh UUID. */
  logId?: string;
  /**
   * When set with `signer`, automatically signs a checkpoint every
   * `checkpointInterval` appended entries.
   */
  checkpointInterval?: number;
  /** Signer used for automatic periodic checkpoints. */
  signer?: ReceiptSigner;
  /** Clock returning ISO 8601 timestamps. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
};

/**
 * Creates an in-memory append-only hash-chained receipt log with optional
 * automatic periodic signed checkpoints.
 */
export function createInMemoryReceiptLog(options: InMemoryReceiptLogOptions = {}): ReceiptLog {
  const logId = options.logId ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date().toISOString());
  const interval = options.checkpointInterval;
  if (interval !== undefined && (!Number.isInteger(interval) || interval < 1)) {
    throw new RangeError(`checkpointInterval must be a positive integer, got ${interval}`);
  }
  if (interval !== undefined && !options.signer) {
    throw new TypeError("signer is required when checkpointInterval is configured");
  }

  const entries: ReceiptLogEntry[] = [];
  const savedCheckpoints: SignedReceiptLogCheckpoint[] = [];

  async function createCheckpoint(
    signer: ReceiptSigner,
    issuedAt?: string,
  ): Promise<SignedReceiptLogCheckpoint> {
    const headEntry = entries[entries.length - 1];
    if (!headEntry) {
      throw new TollwayError("invalid-receipt", "cannot create a checkpoint for an empty receipt log");
    }
    const signed = await signReceiptLogCheckpoint(
      {
        version: 1,
        logId,
        headIndex: headEntry.index,
        headHash: headEntry.entryHash,
        entryCount: entries.length,
        issuedAt: issuedAt ?? now(),
      },
      signer,
    );
    savedCheckpoints.push(signed);
    return signed;
  }

  return {
    logId,
    async append(receipt, appendOptions) {
      const parsed = signedReceiptSchema.safeParse(receipt);
      if (!parsed.success) {
        throw new TollwayError(
          "invalid-receipt",
          `cannot append invalid receipt: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      const index = entries.length;
      const prevHash = index === 0 ? null : entries[index - 1]!.entryHash;
      const recordedAt = appendOptions?.recordedAt ?? now();
      const receiptHash = await computeReceiptHash(parsed.data);
      const entryHash = await computeEntryHash({ index, prevHash, receiptHash, recordedAt });
      const entry: ReceiptLogEntry = {
        index,
        prevHash,
        receipt: parsed.data,
        receiptHash,
        entryHash,
        recordedAt,
      };
      entries.push(entry);

      if (interval !== undefined && options.signer && entries.length % interval === 0) {
        await createCheckpoint(options.signer, recordedAt);
      }
      return entry;
    },
    async head() {
      return entries[entries.length - 1];
    },
    async get(index) {
      if (!Number.isInteger(index) || index < 0) return undefined;
      return entries[index];
    },
    async range(fromIndex = 0, toIndex = entries.length - 1) {
      if (entries.length === 0) return [];
      const start = Math.max(0, fromIndex);
      const end = Math.min(entries.length - 1, toIndex);
      if (end < start) return [];
      return entries.slice(start, end + 1);
    },
    async checkpoint(signer, checkpointOptions) {
      return createCheckpoint(signer, checkpointOptions?.issuedAt);
    },
    async latestCheckpoint() {
      return savedCheckpoints[savedCheckpoints.length - 1];
    },
    async checkpoints() {
      return [...savedCheckpoints];
    },
  };
}
