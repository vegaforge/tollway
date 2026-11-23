import { utf8Bytes } from "../encoding.js";
import { TollwayError } from "../errors.js";

/**
 * Receipt canonicalisation conforms to RFC 8785, the JSON Canonicalization
 * Scheme (JCS). Two structurally equal values always produce identical
 * UTF-8 bytes, which is what makes receipt signatures reproducible across
 * runtimes and across languages. See docs/receipt-format.md ("Verifying in
 * another language") for the published test vectors a verifier in Go, Rust
 * or Python can check its implementation against.
 *
 * RFC 8785 cross-references the parts of ECMAScript it relies on:
 *   - key order: Object.keys(x).sort() compares UTF-16 code units, which
 *     is the ordering RFC 8785 section 3.2.3 specifies;
 *   - number formatting: ECMA-262 ToString(Number) is what JCS section 3.2.2.3
 *     mandates, so JSON.stringify's number handling is correct as-is;
 *   - string escaping: ECMA-262 JSON.stringify applies the JSON string
 *     escaping JCS requires.
 *
 * On top of what `JSON.stringify` does, this module enforces the I-JSON
 * subset RFC 8785 requires at the input: lone surrogates, non-plain
 * objects, `bigint`, `undefined` in arrays, functions and symbols are all
 * rejected with `TollwayError("canonicalization-failed", ...)` rather than
 * silently serialised wrong or thrown as raw `TypeError`s. This is the
 * change from the pre-#165 serialiser; see docs/release-notes/
 * 2026-11-23-jcs-canonicalisation.md.
 */

/** A value that survives a JSON round trip, which is all a receipt body may hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function fail(reason: string): never {
  throw new TollwayError("canonicalization-failed", reason);
}

/**
 * Rejects a string that contains a lone surrogate. UTF-16 high surrogates
 * (0xD800-0xDBFF) must be followed immediately by a low surrogate
 * (0xDC00-0xDFFF); either half appearing alone is invalid I-JSON, and a
 * conforming JCS verifier in another language will reject or replace it.
 * We reject at the input so the bytes the signer signs are always
 * well-formed UTF-8.
 */
function assertNoLoneSurrogate(value: string, where: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`lone high surrogate in ${where}`);
      }
      i += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`lone low surrogate in ${where}`);
    }
  }
}

/**
 * True when `value` is a plain object literal: either `Object.prototype`
 * or a null-prototype object. A `Date`, a class instance, a `Map`, a
 * `RegExp`, or anything else returns false. `JSON.stringify` silently
 * turns many of these into `{}`; we reject them at the canonical boundary
 * so a signing primitive never signs something that does not round-trip.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function walk(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertNoLoneSurrogate(value, `string at ${path}`);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`non-finite number at ${path}: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    fail(`bigint at ${path}: JSON cannot represent it; convert to a decimal string first`);
  }
  if (typeof value === "function") {
    fail(`function at ${path}: JSON cannot represent it`);
  }
  if (typeof value === "symbol") {
    fail(`symbol at ${path}: JSON cannot represent it`);
  }
  if (typeof value === "undefined") {
    fail(`undefined at ${path}: JSON cannot represent it`);
  }
  if (typeof value !== "object") {
    fail(`unsupported type at ${path}: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      if (item === undefined) {
        // Rejecting `undefined` in an array matches RFC 8785's I-JSON
        // requirement that every member has a representation. The old
        // serialiser fell through to the object branch and raised a raw
        // `TypeError`; the new one reports it as a canonicalization
        // failure with the index in the path.
        fail(`undefined at ${path}[${i}]`);
      }
      parts.push(walk(item, `${path}[${i}]`));
    }
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    fail(`non-plain object at ${path}: JSON would silently render as {}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = record[key];
    // `undefined` values on an object are dropped the way `JSON.stringify`
    // drops them. This matches the previous serialiser and gives callers a
    // single spelling for "not present".
    if (item === undefined) continue;
    assertNoLoneSurrogate(key, `object key at ${path}`);
    parts.push(`${JSON.stringify(key)}:${walk(item, `${path}.${key}`)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Deterministic JSON per RFC 8785. Rejects inputs that JSON cannot
 * represent (bigint, functions, symbols, undefined in arrays), inputs
 * that break I-JSON (lone surrogates), and non-plain objects (a `Date`,
 * a class instance) that would silently render as `{}`.
 */
export function canonicalJson(value: JsonValue): string {
  return walk(value, "$");
}

/**
 * The UTF-8 bytes of {@link canonicalJson}. These are the exact bytes a
 * receipt signature covers.
 */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return utf8Bytes(canonicalJson(value));
}
