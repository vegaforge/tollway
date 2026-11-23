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

/**
 * The path to the value being serialised, kept as a stack of keys and array
 * indexes. It is only joined into a string when a value is refused, so the
 * common case, a valid receipt, pays for a push and a pop per member and
 * never builds a path string.
 */
type PathStack = (string | number)[];

function pathLabel(path: PathStack): string {
  let label = "$";
  for (const segment of path) {
    label += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return label;
}

/** Throws `canonicalization-failed` as "<subject> at <path>: <detail>". */
function fail(subject: string, path: PathStack, detail?: string): never {
  const suffix = detail === undefined ? "" : `: ${detail}`;
  throw new TollwayError("canonicalization-failed", `${subject} at ${pathLabel(path)}${suffix}`);
}

/** Names the surrogate {@link LONE_SURROGATE} found, high or low. */
function surrogateKind(value: string): "high" | "low" {
  const match = LONE_SURROGATE.exec(value);
  const unit = match ? match[0].charCodeAt(0) : 0;
  return unit <= 0xdbff ? "high" : "low";
}

/**
 * Matches a lone surrogate. With the `u` flag a well-formed surrogate pair is
 * one code point, so `\p{Cs}` only matches a high surrogate (0xD800-0xDBFF)
 * without a following low one, or a low surrogate (0xDC00-0xDFFF) on its own.
 * Either is invalid I-JSON, and a conforming JCS verifier in another language
 * will reject or replace it, so the signer refuses it instead. The regular
 * expression runs natively, which keeps the check cheap on every string.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * True when `value` is a plain object literal: either `Object.prototype`
 * or a null-prototype object. A `Date`, a class instance, a `Map`, a
 * `RegExp`, or anything else returns false. `JSON.stringify` silently
 * turns many of these into `{}`; they are refused here so a signing
 * primitive never signs something that does not round-trip.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Serialises one value. Validation happens in the same pass as
 * serialisation: each value is checked as it is written, so a valid input
 * is walked exactly once.
 */
function walk(value: unknown, path: PathStack): string {
  switch (typeof value) {
    case "string":
      if (LONE_SURROGATE.test(value))
        fail(`lone ${surrogateKind(value)} surrogate in string`, path);
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) fail(`non-finite number ${value}`, path);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return fail("bigint", path, "JSON cannot represent it; convert it to a decimal string first");
    case "function":
    case "symbol":
    case "undefined":
      return fail(typeof value, path, "JSON cannot represent it");
    default:
      break;
  }
  if (value === null) return "null";
  const object = value as object;
  if (Array.isArray(object)) {
    let out = "[";
    for (let i = 0; i < object.length; i += 1) {
      path.push(i);
      // `undefined` in an array has no JSON representation. The serialiser
      // before #165 raised a raw TypeError here; this reports it with the index.
      out += (i === 0 ? "" : ",") + walk(object[i], path);
      path.pop();
    }
    return `${out}]`;
  }
  if (!isPlainObject(object)) {
    return fail("non-plain object", path, "JSON would silently render it as {}");
  }
  const record = object as Record<string, unknown>;
  // Object.keys(...).sort() compares UTF-16 code units, the order RFC 8785
  // section 3.2.3 specifies.
  const keys = Object.keys(record).sort();
  let out = "{";
  let first = true;
  for (const key of keys) {
    const item = record[key];
    // `undefined` members are dropped the way `JSON.stringify` drops them,
    // as the serialiser before #165 did, so "absent" has one spelling.
    if (item === undefined) continue;
    path.push(key);
    if (LONE_SURROGATE.test(key)) fail(`lone ${surrogateKind(key)} surrogate in object key`, path);
    out += `${first ? "" : ","}${JSON.stringify(key)}:${walk(item, path)}`;
    path.pop();
    first = false;
  }
  return `${out}}`;
}

/**
 * Deterministic JSON per RFC 8785. Rejects inputs that JSON cannot
 * represent (bigint, functions, symbols, undefined in arrays), inputs
 * that break I-JSON (lone surrogates), and non-plain objects (a `Date`,
 * a class instance) that would silently render as `{}`.
 */
export function canonicalJson(value: JsonValue): string {
  return walk(value, []);
}

/**
 * The UTF-8 bytes of {@link canonicalJson}. These are the exact bytes a
 * receipt signature covers.
 */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return utf8Bytes(canonicalJson(value));
}
