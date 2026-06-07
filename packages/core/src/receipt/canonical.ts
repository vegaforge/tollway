import { utf8Bytes } from "../encoding.js";
import { TollwayError } from "../errors.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Deterministic JSON: object keys sorted at every level, no whitespace,
 * undefined properties dropped the way JSON.stringify drops them. Two
 * structurally equal values always produce the same bytes, which is what
 * makes receipt signatures reproducible.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TollwayError("canonicalization-failed", `cannot canonicalize ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

export function canonicalBytes(value: JsonValue): Uint8Array {
  return utf8Bytes(canonicalJson(value));
}
