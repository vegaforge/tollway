/**
 * Receipt-signing key sets and a caching verifier for them (Issue #167).
 *
 * A service publishes a key-set document at a well-known URL so an
 * independent verifier knows which public keys sign that service's
 * receipts. The document format is a JWK Set (RFC 7517) carrying Ed25519
 * public keys in `kty: "OKP", crv: "Ed25519"` form (RFC 8037), extended
 * with a Tollway-specific `status` on each key so operators can mark a
 * key `active`, `retired` (with `retiredAt`) or `revoked`.
 *
 * {@link createKeySetVerifier} is a {@link ReceiptVerifier} that fetches
 * and caches the document, honours `Cache-Control: max-age` within a
 * configurable floor / ceiling, rate-limits refetches on unknown `kid`,
 * and fails closed when the document is unreachable without a cached
 * copy. It runs anywhere `fetch` and WebCrypto do: Node 22+, edge
 * runtimes, and the browser.
 */

import { z } from "zod";
import { base64UrlToBytes } from "../encoding.js";
import { TollwayError } from "../errors.js";
import type { ReceiptVerifier } from "./signer.js";

const ED25519 = "Ed25519";
const EDDSA_ALG = "EdDSA";
const ECDSA_P256_ALG = "ES256";
/**
 * The receipt-signature algorithm identifiers the key-set verifier
 * accepts. `Ed25519` is the pre-#167 v1 value and is kept so receipts
 * signed before the key-set work still verify; `EdDSA` is the RFC 8037
 * JOSE name used in the JWK and in a receipt signed by a key-set-aware
 * signer; `ES256` is JOSE for ECDSA P-256 over SHA-256.
 */
export const RECEIPT_ALGORITHMS = [ED25519, EDDSA_ALG, ECDSA_P256_ALG] as const;
export type ReceiptAlgorithm = (typeof RECEIPT_ALGORITHMS)[number];

/** Collapses `Ed25519` and `EdDSA` into a single canonical name for comparison. */
function canonicalAlg(input: string): string {
  return input === ED25519 ? EDDSA_ALG : input;
}

/** P-256 group order (hex) and n/2, used for the high-S malleability check. */
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_N = P256_N >> 1n;

function isHighS(signature: Uint8Array): boolean {
  let s = 0n;
  for (const byte of signature.subarray(32)) {
    s = (s << 8n) | BigInt(byte);
  }
  return s > P256_HALF_N;
}

const statusSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ state: z.literal("active") }),
    z.strictObject({
      state: z.literal("retired"),
      retiredAt: z.iso.datetime(),
    }),
    z.strictObject({
      state: z.literal("revoked"),
      revokedAt: z.iso.datetime().optional(),
    }),
  ])
  .default({ state: "active" });

/** An Ed25519 key entry in a key-set document, following RFC 8037. */
export const ed25519KeyEntrySchema = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal(ED25519),
  x: z.string().min(1),
  kid: z.string().min(1),
  alg: z.literal(EDDSA_ALG),
  use: z.literal("sig").optional(),
  status: statusSchema,
});

/**
 * A P-256 (`ES256`) key entry in a key-set document (Issue #169). The
 * algorithm is bound to the key record: a receipt whose
 * `signature.algorithm` disagrees with `alg` is rejected, so an attacker
 * cannot have an Ed25519 key record interpret an ES256 signature or the
 * other way round.
 */
export const p256KeyEntrySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().min(1),
  alg: z.literal(ECDSA_P256_ALG),
  use: z.literal("sig").optional(),
  status: statusSchema,
});

/**
 * One key in a key-set document. Discriminated on `kty`; each variant
 * binds a specific algorithm. A verifier decides what to do with the
 * status (`active`, `retired` with a cutoff, `revoked`).
 */
export const keySetEntrySchema = z.discriminatedUnion("kty", [
  ed25519KeyEntrySchema,
  p256KeyEntrySchema,
]);

/** One entry in a key-set document; see {@link keySetEntrySchema}. */
export type KeySetEntry = z.infer<typeof keySetEntrySchema>;

/**
 * A key-set document. `keys` is the JWK Set; `issuedAt` and `expiresAt`
 * are optional document-level fields a server emits when it wants
 * explicit staleness independent of Cache-Control.
 */
export const keySetDocumentSchema = z.strictObject({
  keys: z.array(keySetEntrySchema),
  issuedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime().optional(),
});

/** A receipt-signing key-set; see {@link keySetDocumentSchema}. */
export type KeySetDocument = z.infer<typeof keySetDocumentSchema>;

/**
 * The `fetch` surface the verifier uses. Exactly the Fetch API shape,
 * typed narrowly so a test can pass a `vi.fn()` without `any`.
 */
export type KeySetFetcher = (
  url: string,
) => Promise<{ status: number; headers: Headers; text(): Promise<string> }>;

/** Options for {@link createKeySetVerifier}. */
export type KeySetVerifierOptions = {
  /**
   * URL of the key-set document. Mutually exclusive with `document`.
   * Only this URL is fetched; the verifier never follows a URL taken
   * from a receipt, so a forged receipt cannot steer the verifier.
   */
  url?: string;
  /**
   * In-process document. Useful in tests and in deployments that load
   * the key set at boot and never refetch. Mutually exclusive with
   * `url`.
   */
  document?: KeySetDocument;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: KeySetFetcher;
  /** Injectable clock, in ms. Defaults to `Date.now`. */
  clock?: () => number;
  /**
   * Minimum time a cached document is held before a Cache-Control
   * `max-age` can force a refetch. Defaults to 10 seconds. The floor
   * guards against a misconfigured server returning `max-age=0`.
   */
  minCacheMs?: number;
  /**
   * Maximum time a cached document is held before a refetch is forced,
   * whatever Cache-Control says. Defaults to 24 hours.
   */
  maxCacheMs?: number;
  /**
   * Shortest interval between unknown-kid refetches. A verifier calls
   * refetch when a receipt names a `kid` the cached document does not
   * know; this interval rate-limits those calls so a forged receipt
   * cannot force one fetch per attempt. Defaults to 60 seconds.
   */
  unknownKidRefetchCooldownMs?: number;
};

type CachedDocument = {
  document: KeySetDocument;
  fetchedAt: number;
  expiresAt: number;
  byKid: Map<string, KeySetEntry>;
};

const MIN_CACHE_MS_DEFAULT = 10_000;
const MAX_CACHE_MS_DEFAULT = 24 * 60 * 60 * 1_000;
const UNKNOWN_KID_COOLDOWN_MS_DEFAULT = 60_000;

/**
 * The receiver's view of a key-set verifier, layered on top of the plain
 * {@link ReceiptVerifier} interface with a `refresh()` call that drops
 * the cached document.
 */
export interface KeySetVerifier extends ReceiptVerifier {
  /** Drops the cached document; the next verify refetches. */
  refresh(): Promise<void>;
}

/**
 * Parses a Cache-Control header for `max-age` in seconds. Returns
 * undefined when the header is absent or unparseable. Matching is
 * case-insensitive per RFC 9111.
 */
function parseMaxAgeMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = header.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1_000;
}

function indexByKid(document: KeySetDocument): Map<string, KeySetEntry> {
  const map = new Map<string, KeySetEntry>();
  for (const entry of document.keys) {
    map.set(entry.kid, entry);
  }
  return map;
}

/**
 * Builds a {@link KeySetVerifier} from a `url` or an in-process `document`.
 * One of the two must be set. The verifier caches the document under a
 * `Cache-Control` `max-age` (clamped between `minCacheMs` and
 * `maxCacheMs`), rate-limits unknown-kid refetches, and fails closed if
 * the document is unreachable and no fresh-enough cached copy exists.
 */
export function createKeySetVerifier(options: KeySetVerifierOptions): KeySetVerifier {
  if ((options.url == null) === (options.document == null)) {
    throw new TollwayError(
      "invalid-signing-key",
      "createKeySetVerifier needs exactly one of `url` or `document`",
    );
  }
  const clock = options.clock ?? Date.now;
  const minCacheMs = options.minCacheMs ?? MIN_CACHE_MS_DEFAULT;
  const maxCacheMs = options.maxCacheMs ?? MAX_CACHE_MS_DEFAULT;
  const unknownKidCooldownMs =
    options.unknownKidRefetchCooldownMs ?? UNKNOWN_KID_COOLDOWN_MS_DEFAULT;
  const fetchFn =
    options.fetch ?? (typeof fetch === "function" ? (fetch as KeySetFetcher) : undefined);

  let cached: CachedDocument | undefined =
    options.document !== undefined
      ? {
          document: options.document,
          fetchedAt: clock(),
          expiresAt: clock() + maxCacheMs,
          byKid: indexByKid(options.document),
        }
      : undefined;
  let lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY;
  let pendingFetch: Promise<void> | undefined;

  async function performFetch(): Promise<void> {
    if (!options.url || !fetchFn) {
      throw new TollwayError(
        "payment-failed",
        "key-set verifier has no `url` or no `fetch` to refetch with",
      );
    }
    const response = await fetchFn(options.url);
    if (response.status < 200 || response.status >= 300) {
      throw new TollwayError(
        "payment-failed",
        `key-set document HTTP ${response.status} from ${options.url}`,
      );
    }
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new TollwayError("payment-failed", "key-set document is not valid JSON");
    }
    const result = keySetDocumentSchema.safeParse(parsed);
    if (!result.success) {
      throw new TollwayError(
        "payment-failed",
        `key-set document failed schema check: ${result.error.message}`,
      );
    }
    const now = clock();
    const maxAge = parseMaxAgeMs(response.headers.get("cache-control"));
    const ttl =
      maxAge === undefined ? maxCacheMs : Math.min(Math.max(maxAge, minCacheMs), maxCacheMs);
    cached = {
      document: result.data,
      fetchedAt: now,
      expiresAt: now + ttl,
      byKid: indexByKid(result.data),
    };
  }

  async function ensureFresh(forceIfStale: boolean): Promise<void> {
    const now = clock();
    if (cached && !forceIfStale) return;
    if (cached && forceIfStale && cached.expiresAt > now) return;
    if (!options.url) {
      // In-process document; we never refetch and the cache has no TTL
      // beyond maxCacheMs (treated as never-expiring for `document`).
      return;
    }
    if (pendingFetch) {
      await pendingFetch;
      return;
    }
    pendingFetch = performFetch().finally(() => {
      pendingFetch = undefined;
    });
    try {
      await pendingFetch;
    } catch (error) {
      // Fail closed only when there is no cached copy to fall back on.
      // A fetch failure with a fresh cached copy keeps serving on the
      // cached keys (that is the point of a cache).
      if (!cached) throw error;
      // Cached copy is stale but we could not refresh — keep using it
      // until maxCacheMs elapses.
      if (cached.expiresAt <= now - maxCacheMs) throw error;
    }
  }

  /**
   * Called when a receipt names a `kid` the cached document does not know.
   * A single refetch per `unknownKidCooldownMs` window keeps a forged
   * stream of receipts from hammering the key-set URL.
   */
  async function maybeRefetchForUnknownKid(now: number): Promise<void> {
    if (!options.url) return;
    if (now - lastUnknownKidFetchAt < unknownKidCooldownMs) return;
    lastUnknownKidFetchAt = now;
    try {
      await performFetch();
    } catch {
      // Keep serving on the previously cached document.
    }
  }

  async function verify(input: {
    message: Uint8Array;
    signature: Uint8Array;
    keyId: string;
    algorithm: string;
  }): Promise<boolean> {
    if (!(RECEIPT_ALGORITHMS as readonly string[]).includes(input.algorithm)) return false;
    await ensureFresh(cached ? cached.expiresAt <= clock() : true);
    if (!cached) return false;
    let entry = cached.byKid.get(input.keyId);
    if (!entry) {
      await maybeRefetchForUnknownKid(clock());
      entry = cached.byKid.get(input.keyId);
      if (!entry) return false;
    }
    // Algorithm must be bound to the key record (Issue #169). A receipt
    // whose `signature.algorithm` disagrees with the entry's `alg` is
    // rejected, so an Ed25519 record never verifies an ES256 signature
    // and the other way round. `Ed25519` (pre-#167 receipt spelling) and
    // `EdDSA` (JWK/JOSE spelling) are treated as the same algorithm.
    if (canonicalAlg(entry.alg) !== canonicalAlg(input.algorithm)) return false;
    if (entry.status.state === "revoked") {
      // Revoked means reject every receipt the key ever signed. A
      // compromised signer can backdate `issuedAt`, so there is no
      // honest cutoff.
      return false;
    }
    if (entry.status.state === "retired") {
      // Retired is a planned rotation. A retired key verifies receipts
      // whose body says they were issued strictly before `retiredAt`,
      // and fails anything later. We scan the canonical bytes for the
      // `issuedAt` field so the signature-level check does not depend
      // on a second full parse.
      const retiredMs = Date.parse(entry.status.retiredAt);
      const issuedMs = readIssuedAt(input.message);
      if (issuedMs === undefined) return false;
      if (issuedMs >= retiredMs) return false;
    }
    if (entry.kty === "OKP") {
      const raw = base64UrlToBytes(entry.x);
      const key = await crypto.subtle.importKey("raw", raw as BufferSource, ED25519, false, [
        "verify",
      ]);
      return crypto.subtle.verify(
        ED25519,
        key,
        input.signature as BufferSource,
        input.message as BufferSource,
      );
    }
    // P-256: reject the length check and high-S up front so a malleated
    // signature cannot verify alongside its canonical form.
    if (input.signature.length !== 64) return false;
    if (isHighS(input.signature)) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: entry.x,
        y: entry.y,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      input.signature as BufferSource,
      input.message as BufferSource,
    );
  }

  return {
    verify,
    async refresh() {
      cached = undefined;
      lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY;
      await ensureFresh(true);
    },
  };
}

/**
 * Reads the `issuedAt` timestamp out of canonical-receipt bytes without
 * fully decoding the JSON. The canonical form guarantees keys are sorted
 * and strings are RFC 8259 JSON strings, so a simple string search for
 * `"issuedAt":"...Z"` is unambiguous for v1 receipts. Returns the ms
 * timestamp on success, undefined otherwise. The key-set verifier uses
 * this only for the `retired` cutoff; the signature check does not
 * depend on it.
 */
function readIssuedAt(message: Uint8Array): number | undefined {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(message);
  const match = text.match(/"issuedAt":"([^"]+)"/);
  if (!match) return undefined;
  const parsed = Date.parse(match[1] ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}
