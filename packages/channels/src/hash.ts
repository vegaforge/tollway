/**
 * Deterministic, non-cryptographic hashing for the mock channel adapter only.
 * Gives the mock stable ids and commitment blobs so tests and the offline demo
 * are reproducible. Never used on a real settlement path.
 *
 * The algorithm is FNV-1a, the same one the server's mock facilitator uses.
 * Both are for offline testing and must never appear in production code paths.
 */

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A hex string of the requested length, derived only from the input. */
export function mockHex(input: string, length = 64): string {
  let out = "";
  let round = 0;
  while (out.length < length) {
    out += fnv1a(`${input}:${round}`).toString(16).padStart(8, "0");
    round++;
  }
  return out.slice(0, length);
}

/** A Stellar contract address placeholder (C...). Not a real address. */
export function mockContractId(seed: string): string {
  return `C${mockHex(seed, 55).toUpperCase()}`;
}
