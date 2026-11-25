/**
 * Append-only JSON Lines store for the hash-chained receipt log (#171).
 *
 * One entry per line, each line the canonical JSON (#165) of the entry and a
 * newline. Every append is followed by `fsync`, so an entry `append` has
 * resolved survives a crash. A crash during a write can leave a partial last
 * line; opening such a file fails until `repairJsonlReceiptLog` cuts the
 * partial line off, so a torn write is never silently read as the head.
 *
 * `node:fs` is loaded inside the factories, never at module load, so an edge
 * runtime that only uses the in-memory store can still import this package.
 * The format and the chain logic live in `@vegaforge/tollway-core`; see
 * docs/receipt-log.md.
 */

import {
  assertExtendsHead,
  assertReadRange,
  canonicalJson,
  type JsonValue,
  type ReceiptLogEntry,
  type ReceiptLogHead,
  type ReceiptLogStore,
  receiptLogEntrySchema,
  TollwayError,
  verifyReceiptLog,
} from "@vegaforge/tollway-core";

type FsPromises = typeof import("node:fs/promises");
type FileHandle = Awaited<ReturnType<FsPromises["open"]>>;

/** Options for {@link openJsonlReceiptLogStore}. */
export type JsonlReceiptLogStoreOptions = {
  /** The log file. It is created if it does not exist. */
  path: string;
};

/** A `ReceiptLogStore` from `@vegaforge/tollway-core` over one JSON Lines file. */
export type JsonlReceiptLogStore = ReceiptLogStore & {
  readonly path: string;
  /** Closes the file. Later appends throw. */
  close(): Promise<void>;
};

const NEWLINE = 0x0a;

function loadFs(feature: string): FsPromises {
  const unavailable = () =>
    new Error(`${feature} needs node:fs/promises, which this runtime does not provide`);
  if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") {
    throw unavailable();
  }
  const fs = process.getBuiltinModule("node:fs/promises");
  if (!fs) throw unavailable();
  return fs;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readBytes(fs: FsPromises, path: string): Promise<Uint8Array> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if (isMissingFile(error)) return new Uint8Array();
    throw error;
  }
}

function corrupt(path: string, detail: string): TollwayError {
  return new TollwayError("corrupt-receipt-log", `receipt log ${path}: ${detail}`);
}

/** Parses every line of a log file. Each line must be a complete, valid entry. */
function parseLines(path: string, bytes: Uint8Array): ReceiptLogEntry[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== NEWLINE) {
    throw corrupt(
      path,
      "the last line is partial, probably from a crash during a write; run repairJsonlReceiptLog to remove it",
    );
  }
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, -1).split("\n");
  return lines.map((line, index) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw corrupt(path, `line ${index + 1} is not JSON`);
    }
    const parsed = receiptLogEntrySchema.safeParse(json);
    if (!parsed.success) {
      throw corrupt(path, `line ${index + 1} is not a receipt log entry`);
    }
    return parsed.data;
  });
}

/**
 * Opens (or creates) a JSON Lines receipt log. The whole chain is checked on
 * open, so a file edited by hand or torn by a crash is refused rather than
 * extended. Receipt signatures are not checked here; run `verifyReceiptLog`
 * with a verifier and a checkpoint for that.
 *
 * One writer per file. Two stores open on the same file, in one process or
 * several, would each extend their own idea of the head and fork the chain.
 * Several writers need a store whose append is an atomic compare-and-set.
 *
 * `read` re-reads the file, so it costs time linear in the log's size.
 */
export async function openJsonlReceiptLogStore(
  options: JsonlReceiptLogStoreOptions,
): Promise<JsonlReceiptLogStore> {
  const fs = loadFs("openJsonlReceiptLogStore");
  const { path } = options;
  const existing = parseLines(path, await readBytes(fs, path));
  const chain = await verifyReceiptLog(existing);
  if (!chain.valid) {
    throw corrupt(path, `${chain.kind} at seq ${chain.seq}: ${chain.reason}`);
  }
  let head: ReceiptLogHead = { size: chain.size, headHash: chain.headHash };
  let handle: FileHandle | undefined = await fs.open(path, "a");
  // After a failed write the file may end in a partial line. Appending more
  // would bury it, so the store stops and the file must be reopened (and
  // repaired if needed).
  let broken: unknown;

  return {
    path,
    async head() {
      return head;
    },
    async append(entry) {
      if (!handle) {
        throw new TollwayError("corrupt-receipt-log", `receipt log ${path} is closed`);
      }
      if (broken !== undefined) {
        throw new TollwayError(
          "corrupt-receipt-log",
          `receipt log ${path} stopped after a failed write; reopen it`,
          { cause: broken },
        );
      }
      assertExtendsHead(head, entry);
      const line = `${canonicalJson(entry as unknown as JsonValue)}\n`;
      try {
        await handle.appendFile(line, "utf8");
        await handle.sync();
      } catch (error) {
        broken = error;
        throw error;
      }
      head = { size: entry.seq + 1, headHash: entry.entryHash };
    },
    async read(fromSeq, limit) {
      assertReadRange(fromSeq, limit);
      const entries = parseLines(path, await readBytes(fs, path));
      return entries.slice(fromSeq, Math.min(fromSeq + limit, head.size));
    },
    async close() {
      const open = handle;
      handle = undefined;
      await open?.close();
    },
  };
}

/** The result of {@link repairJsonlReceiptLog}. */
export type JsonlReceiptLogRepair = {
  /** Bytes cut from the end of the file: the partial last line, or 0. */
  removedBytes: number;
};

/**
 * Cuts a partial last line off a JSON Lines receipt log, the trace of a crash
 * during a write. Complete lines are never touched, and the entry that was
 * being written is lost (its `append` never resolved). Run it only while no
 * store has the file open, then open the store again.
 */
export async function repairJsonlReceiptLog(path: string): Promise<JsonlReceiptLogRepair> {
  const fs = loadFs("repairJsonlReceiptLog");
  const bytes = await readBytes(fs, path);
  if (bytes.length === 0 || bytes[bytes.length - 1] === NEWLINE) {
    return { removedBytes: 0 };
  }
  const keep = bytes.lastIndexOf(NEWLINE) + 1;
  await fs.truncate(path, keep);
  return { removedBytes: bytes.length - keep };
}
