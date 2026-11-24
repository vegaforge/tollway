import { TollwayError } from "@vegaforge/tollway-core";

/**
 * How an adapter hands the gate the request body for body binding (#164).
 * `read` returns the exact bytes the client sent, and throws
 * {@link BodyTooLargeError} as soon as more than `maxBytes` have arrived,
 * without reading the rest. Reading must leave the body available to the
 * route handler: each adapter reads a copy, or re-provides what it read.
 */
export type RequestBodySource = {
  read(maxBytes: number): Promise<Uint8Array>;
};

/** Thrown by a {@link RequestBodySource} once a body passes its limit. */
export class BodyTooLargeError extends TollwayError {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super("body-too-large", `the request body is larger than ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/** Joins chunks into one array. */
export function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads a Web stream to the end, chunk by chunk, and stops as soon as the
 * total passes `maxBytes`: the limit is enforced while streaming, so an
 * oversized upload is never buffered whole. A null stream is an empty body.
 */
export async function readBodyStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop and leave the rest unread. Cancelling is not awaited: for a
      // cloned request the stream is one branch of a tee, and its cancel
      // only settles once the other branch is cancelled too.
      reader.releaseLock();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return concatChunks(chunks, total);
}

/** A body that is already in memory, for adapters and tests that hold the bytes. */
export function bytesBody(bytes: Uint8Array): RequestBodySource {
  return {
    async read(maxBytes) {
      if (bytes.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
      return bytes;
    },
  };
}
