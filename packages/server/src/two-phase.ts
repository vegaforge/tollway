/**
 * What the four adapters share for two-phase settlement (#152). The payment
 * logic is in `gate.authorize`; these helpers only hold a route's response
 * while it settles, so every adapter buffers, limits and replaces a response
 * the same way. See docs/design.md, "Design notes" (failure semantics).
 */

import type { AuthorizeOutcome, Gate, PaywallGate, TollwayRequest } from "./gate.js";
import { type GateRejection, gateRejection } from "./gate-errors.js";

/**
 * When an adapter settles a payment. `"before-handler"` (the default) settles
 * before the route runs, as the single-shot gate always has.
 * `"after-handler"` verifies and locks the payment, runs the route with its
 * response held, and settles only if the route succeeded.
 */
export type SettlementTiming = "before-handler" | "after-handler";

/** The option every adapter takes, under the same name. */
export type PaywallOptions = { settlement?: SettlementTiming };

/**
 * The authorize function for an adapter running two-phase, or undefined for
 * the default. Fails at construction, not on the first request, when the
 * option is unknown or the gate cannot settle after the handler (a hand-written
 * `Gate` function instead of one from `createPaywall` or a route table).
 */
export function twoPhaseAuthorizer(
  gate: Gate,
  options: PaywallOptions | undefined,
): ((request: TollwayRequest) => Promise<AuthorizeOutcome>) | undefined {
  if (settlementTiming(options) === "before-handler") return undefined;
  if (!isPaywallGate(gate)) {
    throw new TypeError(
      'settlement: "after-handler" needs a gate from createPaywall or a route table; this gate has no authorize()',
    );
  }
  return (request) => gate.authorize(request);
}

/** The timing an adapter's options ask for. Throws on anything but the two names. */
export function settlementTiming(options: PaywallOptions | undefined): SettlementTiming {
  const settlement: unknown = options?.settlement ?? "before-handler";
  if (settlement !== "before-handler" && settlement !== "after-handler") {
    throw new TypeError(
      `settlement must be "before-handler" or "after-handler", got ${JSON.stringify(settlement)}`,
    );
  }
  return settlement;
}

function isPaywallGate(gate: Gate): gate is PaywallGate {
  return typeof (gate as Partial<PaywallGate>).authorize === "function";
}

/** The answer when a route's response is larger than the gate holds. */
export function responseTooLarge(maxBytes: number): GateRejection {
  return gateRejection(
    "response-too-large",
    `the route's response is larger than the ${maxBytes} bytes held while a payment settles, so the payment was not settled`,
  );
}

/**
 * Reads a Web response body, at most `maxBytes`. On overflow it cancels the
 * stream and reports it, so a streamed response never grows past the limit
 * in memory.
 */
export async function readBodyWithin(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false }> {
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, bytes: concat(chunks, total) };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The parts of Node's `http.ServerResponse` the hold uses. Typed by shape so
 * this package does not depend on Node's types; Express and Fastify both pass
 * their underlying `ServerResponse`.
 */
export type HoldableNodeResponse = {
  statusCode: number;
  write: (...args: never[]) => unknown;
  end: (...args: never[]) => unknown;
  writeHead: (...args: never[]) => unknown;
  flushHeaders: (...args: never[]) => unknown;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  getHeaderNames(): string[];
  removeHeader(name: string): void;
  once(event: "close", listener: () => void): unknown;
  readonly writableEnded: boolean;
};

/** How a held Node response finished. */
export type HoldResult = "ended" | "too-large" | "closed";

/** A Node response whose body is being held until the payment settles. */
export type HeldNodeResponse = {
  /** Resolves once: the route ended its response, outgrew the hold, or the client left. */
  done: Promise<HoldResult>;
  /** The status the route set. */
  status(): number;
  /** Sends the held response as the route wrote it, plus `headers`. */
  release(headers?: Record<string, string>): void;
  /** Drops the held response, headers included, and sends a JSON body instead. */
  replace(status: number, body: unknown, headers?: Record<string, string>): void;
};

type EncodingBuffer = { from(value: string, encoding: string): Uint8Array };

/**
 * Holds everything a route writes to a Node response until `release` or
 * `replace`. `writeHead`, `write`, `end` and `flushHeaders` are replaced on
 * this one response, so nothing reaches the socket early and the payment
 * headers can still be added. Writes after the hold has decided are dropped:
 * the route may still be streaming when a too-large response is replaced.
 */
export function holdNodeResponse(res: HoldableNodeResponse, maxBytes: number): HeldNodeResponse {
  const original = {
    end: res.end,
    writeHead: res.writeHead,
    flushHeaders: res.flushHeaders,
    setHeader: res.setHeader,
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finish: (result: HoldResult) => void = () => {};
  let finished = false;
  const done = new Promise<HoldResult>((resolve) => {
    finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
  });

  const take = (chunk: unknown, encoding: unknown): void => {
    if (finished || chunk === undefined || chunk === null || typeof chunk === "function") return;
    const bytes = toBytes(chunk, typeof encoding === "string" ? encoding : undefined);
    total += bytes.byteLength;
    if (total > maxBytes) {
      chunks.length = 0;
      finish("too-large");
      return;
    }
    chunks.push(bytes);
  };
  // Node takes the callback in whichever slot follows the arguments given.
  const callback = (args: unknown[]): void => {
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const cb = args[index];
      if (typeof cb === "function") {
        queueMicrotask(() => cb());
        return;
      }
    }
  };

  res.writeHead = ((status: unknown, ...rest: unknown[]) => {
    if (typeof status === "number") res.statusCode = status;
    for (const headers of rest) applyHeaders(res, headers);
    return res;
  }) as HoldableNodeResponse["writeHead"];
  res.flushHeaders = (() => {}) as HoldableNodeResponse["flushHeaders"];
  res.write = ((chunk: unknown, encoding?: unknown, ...rest: unknown[]) => {
    take(chunk, encoding);
    callback([chunk, encoding, ...rest]);
    return true;
  }) as HoldableNodeResponse["write"];
  res.end = ((chunk?: unknown, encoding?: unknown, ...rest: unknown[]) => {
    take(chunk, encoding);
    callback([chunk, encoding, ...rest]);
    finish("ended");
    return res;
  }) as HoldableNodeResponse["end"];
  res.once("close", () => {
    if (!res.writableEnded) finish("closed");
  });

  // Node's end() writes the head through this.writeHead, so the real one
  // goes back first. write and end stay held, which drops late route writes.
  const send = (body: Uint8Array | string): void => {
    res.writeHead = original.writeHead;
    res.flushHeaders = original.flushHeaders;
    Reflect.apply(original.end, res, [body]);
  };

  return {
    done,
    status: () => res.statusCode,
    release(headers = {}) {
      for (const [name, value] of Object.entries(headers)) {
        Reflect.apply(original.setHeader, res, [name, value]);
      }
      send(
        concat(
          chunks,
          chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
        ),
      );
    },
    replace(status, body, headers = {}) {
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      res.statusCode = status;
      const json = JSON.stringify(body);
      Reflect.apply(original.setHeader, res, ["content-type", "application/json; charset=utf-8"]);
      for (const [name, value] of Object.entries(headers)) {
        Reflect.apply(original.setHeader, res, [name, value]);
      }
      send(json);
    },
  };
}

function toBytes(chunk: unknown, encoding: string | undefined): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  const text = String(chunk);
  if (encoding === undefined || /^utf-?8$/i.test(encoding)) {
    return new TextEncoder().encode(text);
  }
  // Another encoding (latin1, base64, hex) needs Node's Buffer, which every
  // runtime that hands us a ServerResponse has.
  const buffer = (globalThis as { Buffer?: EncodingBuffer }).Buffer;
  if (!buffer) throw new TypeError(`cannot hold a response written in ${encoding}`);
  return buffer.from(text, encoding);
}

/** Copies headers given to `writeHead` (an object, or a flat or paired list) onto the response. */
function applyHeaders(res: HoldableNodeResponse, headers: unknown): void {
  if (Array.isArray(headers)) {
    const flat: unknown[] = headers.flat();
    for (let index = 0; index + 1 < flat.length; index += 2) {
      res.setHeader(String(flat[index]), String(flat[index + 1]));
    }
    return;
  }
  if (typeof headers !== "object" || headers === null) return;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    res.setHeader(
      name,
      Array.isArray(value) ? value.map(String) : typeof value === "number" ? value : String(value),
    );
  }
}
