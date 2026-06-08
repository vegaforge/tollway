/**
 * Deterministic, dependency-free hashing for the mock facilitator. This is
 * not cryptographic and is never used on a real settlement path; it only
 * gives the mock stable, reproducible transaction hashes and account ids so
 * tests and the offline demo behave the same way every run.
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

/** A Stellar-shaped placeholder account id. Not a real key. */
export function mockAccount(seed: string): string {
  return `G${mockHex(seed, 55).toUpperCase()}`;
}
