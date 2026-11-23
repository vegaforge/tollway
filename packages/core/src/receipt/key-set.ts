/**
 * Receipt-signing key sets and a caching verifier for them (Issue #167).
 *
 * A service publishes a key-set document at a well-known URL so an
 * independent verifier knows which public keys sign that service's
 * receipts. The document is a JWK Set (RFC 7517). Ed25519 keys use the
 * `kty: "OKP", crv: "Ed25519"` form (RFC 8037) and P-256 keys the
 * `kty: "EC", crv: "P-256"` form (#169). Each key carries a Tollway
 * `status`: `active`, `retired` (with `retiredAt`) or `revoked`.
 *
 * {@link createKeySetVerifier} is a {@link ReceiptVerifier} that fetches and
 * caches the document, honours `Cache-Control: max-age` between a floor and
 * a ceiling, rate-limits refetches, and fails closed once its copy is too
 * old. It runs anywhere `fetch` and WebCrypto do: Node 22+, edge runtimes
 * and the browser.
 */

import { z } from "zod";
import { base64UrlToBytes } from "../encoding.js";
import { TollwayError } from "../errors.js";
import {
  canonicalAlgorithm,
  ED25519_PUBLIC_KEY_BYTES,
  EDDSA_ALGORITHM,
  ES256_ALGORITHM,
  importEd25519PublicKey,
  importP256PublicKey,
  isReceiptAlgorithm,
  P256_SCALAR_BYTES,
  verifyEd25519,
  verifyEs256,
} from "./algorithms.js";
import type { ReceiptVerifier, SignatureCheck, SignatureInput } from "./signer.js";

export { RECEIPT_ALGORITHMS, type ReceiptAlgorithm } from "./algorithms.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A base64url string that decodes to exactly `bytes` bytes. */
function base64UrlOfLength(bytes: number) {
  return z
    .string()
    .regex(BASE64URL, "expected base64url without padding")
    .refine((value) => base64UrlToBytes(value).length === bytes, {
      message: `expected ${bytes} bytes`,
    });
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
  crv: z.literal("Ed25519"),
  x: base64UrlOfLength(ED25519_PUBLIC_KEY_BYTES),
  kid: z.string().min(1),
  alg: z.literal(EDDSA_ALGORITHM),
  use: z.literal("sig").optional(),
  status: statusSchema,
});

/**
 * A P-256 (`ES256`) key entry in a key-set document (Issue #169). The
 * algorithm is bound to the key record: a receipt whose
 * `signature.algorithm` disagrees with `alg` is rejected, so an Ed25519
 * record never checks an ES256 signature, or the other way round.
 */
export const p256KeyEntrySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: base64UrlOfLength(P256_SCALAR_BYTES),
  y: base64UrlOfLength(P256_SCALAR_BYTES),
  kid: z.string().min(1),
  alg: z.literal(ES256_ALGORITHM),
  use: z.literal("sig").optional(),
  status: statusSchema,
});

/**
 * One key in a key-set document. Discriminated on `kty`; each variant
 * binds one algorithm. The verifier decides what the status means.
 */
export const keySetEntrySchema = z.discriminatedUnion("kty", [
  ed25519KeyEntrySchema,
  p256KeyEntrySchema,
]);

/** One entry in a key-set document; see {@link keySetEntrySchema}. */
export type KeySetEntry = z.infer<typeof keySetEntrySchema>;

/**
 * A key-set document. `keys` is the JWK Set, and every `kid` in it is
 * unique: two entries with one `kid` would leave it to the parser which
 * key, and which status, applies. `expiresAt`, when set, caps how long a
 * verifier caches the document, whatever `Cache-Control` says.
 */
export const keySetDocumentSchema = z
  .strictObject({
    keys: z.array(keySetEntrySchema),
    issuedAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    document.keys.forEach((entry, index) => {
      if (seen.has(entry.kid)) {
        ctx.addIssue({
          code: "custom",
          path: ["keys", index, "kid"],
          message: `duplicate kid ${entry.kid}`,
        });
      }
      seen.add(entry.kid);
    });
  });

/** A receipt-signing key set; see {@link keySetDocumentSchema}. */
export type KeySetDocument = z.infer<typeof keySetDocumentSchema>;

/**
 * Parses a key-set document, throwing `invalid-key-set` with every issue
 * and its path. Both the verifier and the server's response helper use it,
 * so a document is checked the same way on each side.
 */
export function parseKeySetDocument(input: unknown): KeySetDocument {
  const result = keySetDocumentSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new TollwayError("invalid-key-set", `key-set document is invalid: ${issues}`);
  }
  return result.data;
}

/**
 * The `fetch` surface the verifier uses. A subset of the Fetch API, typed
 * narrowly so a test can pass a stub.
 */
export type KeySetFetcher = (
  url: string,
) => Promise<{ status: number; headers: Headers; text(): Promise<string> }>;

/** Options for {@link createKeySetVerifier}. */
export type KeySetVerifierOptions = {
  /**
   * URL of the key-set document. Set exactly one of `url` and `document`.
   * Only this URL is ever fetched; the verifier never follows a URL taken
   * from a receipt, so a forged receipt cannot steer it.
   */
  url?: string;
  /**
   * An in-process document, for tests and for deployments that load the key
   * set at boot. It is parsed when the verifier is created and never
   * refetched. Set exactly one of `url` and `document`.
   */
  document?: KeySetDocument;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: KeySetFetcher;
  /** Injectable clock, in ms. Defaults to `Date.now`. */
  clock?: () => number;
  /**
   * Shortest time a fetched document is cached, whatever `max-age` says.
   * Guards against a server that sends `max-age=0`. Defaults to 10 seconds.
   */
  minCacheMs?: number;
  /**
   * Longest time a fetched document is cached, whatever `max-age` says.
   * Defaults to 1 hour.
   */
  maxCacheMs?: number;
  /**
   * How long a document is cached when the response has no `max-age`,
   * clamped between `minCacheMs` and `maxCacheMs`. Defaults to 5 minutes.
   */
  defaultCacheMs?: number;
  /**
   * How long an expired document may still be used while refetching it
   * fails. Defaults to 0: once the cached copy expires and the URL cannot be
   * read, every receipt fails with "key set unavailable". A revocation
   * reaches this verifier at most one cache lifetime plus `staleIfErrorMs`
   * after it is published.
   */
  staleIfErrorMs?: number;
  /**
   * After a failed fetch, the verifier does not fetch again for this long,
   * so a key-set URL that is down is not hit once per receipt. Defaults to
   * 30 seconds.
   */
  failureBackoffMs?: number;
  /**
   * Shortest interval between refetches caused by a receipt naming a `kid`
   * the cached document does not have. Stops a stream of forged receipts
   * from forcing one fetch each. Defaults to 60 seconds.
   */
  unknownKidRefetchCooldownMs?: number;
};

const MIN_CACHE_MS_DEFAULT = 10_000;
const MAX_CACHE_MS_DEFAULT = 60 * 60 * 1_000;
const DEFAULT_CACHE_MS_DEFAULT = 5 * 60 * 1_000;
const STALE_IF_ERROR_MS_DEFAULT = 0;
const FAILURE_BACKOFF_MS_DEFAULT = 30_000;
const UNKNOWN_KID_COOLDOWN_MS_DEFAULT = 60_000;

/**
 * A {@link ReceiptVerifier} over a key set. `check` gives the reason a
 * receipt fails (for example "key k1 is revoked"), and `verifyReceipt` uses
 * it. `verify` is the boolean form.
 */
export interface KeySetVerifier extends ReceiptVerifier {
  check(input: SignatureInput): Promise<SignatureCheck>;
  /**
   * Fetches the document now, ignoring the cache lifetime and the
   * cooldowns. On success the new document replaces the cached one; on
   * failure it throws `key-set-unavailable` and keeps the cached copy. For a
   * verifier built from a `document`, it does nothing.
   */
  refresh(): Promise<void>;
}

/** A key from the document, imported once and kept with its entry. */
type PreparedKey = { entry: KeySetEntry; key: CryptoKey };

type PreparedDocument = {
  keys: Map<string, PreparedKey>;
  /** When this copy stops being fresh, in clock ms. */
  expiresAt: number;
};

function nonNegative(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new TollwayError("invalid-key-set", `${name} must be a non-negative number of ms`);
  }
  return resolved;
}

/**
 * Parses a Cache-Control header for `max-age`, in ms. Returns undefined
 * when the header or the directive is absent. Matching is case-insensitive
 * (RFC 9111).
 */
function parseMaxAgeMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = header.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  if (!match) return undefined;
  return Number(match[1]) * 1_000;
}

/**
 * Imports every key in a parsed document. A key WebCrypto refuses (a P-256
 * point that is not on the curve, for example) makes the whole document
 * invalid: a verifier should not trust half of a key set.
 */
async function prepare(document: KeySetDocument, expiresAt: number): Promise<PreparedDocument> {
  const keys = new Map<string, PreparedKey>();
  for (const entry of document.keys) {
    let key: CryptoKey;
    try {
      key =
        entry.kty === "OKP"
          ? await importEd25519PublicKey(base64UrlToBytes(entry.x))
          : await importP256PublicKey(entry.x, entry.y);
    } catch (error) {
      throw new TollwayError(
        "invalid-key-set",
        `key-set document is invalid: key ${entry.kid} could not be imported`,
        { cause: error },
      );
    }
    keys.set(entry.kid, { entry, key });
  }
  return { keys, expiresAt };
}

/**
 * Reads `issuedAt` from the canonical receipt bytes the signature covers.
 * Returns undefined when the bytes are not a JSON object with an ISO 8601
 * `issuedAt`.
 */
function readIssuedAt(message: Uint8Array): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("issuedAt" in parsed)) return undefined;
  const issuedAt = parsed.issuedAt;
  if (typeof issuedAt !== "string") return undefined;
  const ms = Date.parse(issuedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a {@link KeySetVerifier} from a `url` or an in-process `document`.
 * Throws `invalid-key-set` when the options are inconsistent or the
 * `document` is invalid. Verification itself never throws: an unreachable
 * key set, an unknown key, a revoked key and a bad signature all come back
 * as an invalid check with a reason.
 */
export function createKeySetVerifier(options: KeySetVerifierOptions): KeySetVerifier {
  if ((options.url == null) === (options.document == null)) {
    throw new TollwayError(
      "invalid-key-set",
      "createKeySetVerifier needs exactly one of `url` or `document`",
    );
  }
  const clock = options.clock ?? Date.now;
  const minCacheMs = nonNegative("minCacheMs", options.minCacheMs, MIN_CACHE_MS_DEFAULT);
  const maxCacheMs = nonNegative("maxCacheMs", options.maxCacheMs, MAX_CACHE_MS_DEFAULT);
  if (maxCacheMs < minCacheMs) {
    throw new TollwayError("invalid-key-set", "maxCacheMs must not be below minCacheMs");
  }
  const defaultCacheMs = nonNegative(
    "defaultCacheMs",
    options.defaultCacheMs,
    DEFAULT_CACHE_MS_DEFAULT,
  );
  const staleIfErrorMs = nonNegative(
    "staleIfErrorMs",
    options.staleIfErrorMs,
    STALE_IF_ERROR_MS_DEFAULT,
  );
  const failureBackoffMs = nonNegative(
    "failureBackoffMs",
    options.failureBackoffMs,
    FAILURE_BACKOFF_MS_DEFAULT,
  );
  const unknownKidCooldownMs = nonNegative(
    "unknownKidRefetchCooldownMs",
    options.unknownKidRefetchCooldownMs,
    UNKNOWN_KID_COOLDOWN_MS_DEFAULT,
  );
  const url = options.url;
  const fetchFn =
    options.fetch ?? (typeof fetch === "function" ? (fetch as KeySetFetcher) : undefined);
  if (url !== undefined && fetchFn === undefined) {
    throw new TollwayError("invalid-key-set", "no `fetch` is available to read the key set");
  }

  // A static document is parsed now, so a bad one fails at startup, and
  // imported once. It never expires and is never refetched.
  const staticDocument: Promise<PreparedDocument> | undefined =
    options.document === undefined
      ? undefined
      : prepare(parseKeySetDocument(options.document), Number.POSITIVE_INFINITY);
  // A rejected import is reported by every check() as its reason. This
  // handler only stops it counting as an unhandled rejection before the
  // first check awaits it.
  staticDocument?.then(undefined, () => "reported by check");

  let cached: PreparedDocument | undefined;
  let pendingFetch: Promise<PreparedDocument> | undefined;
  let lastFailure: { at: number; error: unknown } | undefined;
  let lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY;

  async function fetchDocument(): Promise<PreparedDocument> {
    if (url === undefined || fetchFn === undefined) {
      throw new TollwayError("invalid-key-set", "this key-set verifier has no URL to fetch");
    }
    let response: Awaited<ReturnType<KeySetFetcher>>;
    try {
      response = await fetchFn(url);
    } catch (error) {
      throw new TollwayError(
        "key-set-unavailable",
        `key set fetch failed: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TollwayError("key-set-unavailable", `key set answered HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch (error) {
      throw new TollwayError("invalid-key-set", "key-set document is not valid JSON", {
        cause: error,
      });
    }
    const document = parseKeySetDocument(body);
    const now = clock();
    const maxAge = parseMaxAgeMs(response.headers.get("cache-control"));
    const ttl = Math.min(Math.max(maxAge ?? defaultCacheMs, minCacheMs), maxCacheMs);
    let expiresAt = now + ttl;
    if (document.expiresAt !== undefined) {
      expiresAt = Math.min(expiresAt, Date.parse(document.expiresAt));
    }
    return prepare(document, expiresAt);
  }

  /**
   * Fetches once, sharing the request with concurrent callers. Records a
   * failure for the backoff, and replaces the cache on success.
   */
  function refetch(): Promise<PreparedDocument> {
    if (pendingFetch) return pendingFetch;
    pendingFetch = fetchDocument()
      .then((document) => {
        cached = document;
        lastFailure = undefined;
        return document;
      })
      .catch((error: unknown) => {
        lastFailure = { at: clock(), error };
        throw error;
      })
      .finally(() => {
        pendingFetch = undefined;
      });
    return pendingFetch;
  }

  /**
   * The document to check against, or the reason there is none. A fresh
   * cached copy is used as is. An expired one triggers a refetch unless the
   * last fetch failed within `failureBackoffMs`; when the refetch fails, the
   * expired copy is still used for `staleIfErrorMs` after it expired, and
   * after that the verifier fails closed.
   */
  async function currentDocument(): Promise<PreparedDocument | { unavailable: string }> {
    if (staticDocument) {
      try {
        return await staticDocument;
      } catch (error) {
        return { unavailable: errorMessage(error) };
      }
    }
    const now = clock();
    if (cached && now < cached.expiresAt) return cached;
    let failure: unknown = lastFailure?.error;
    const backingOff = lastFailure !== undefined && now - lastFailure.at < failureBackoffMs;
    if (!backingOff) {
      try {
        return await refetch();
      } catch (error) {
        failure = error;
      }
    }
    if (cached && clock() < cached.expiresAt + staleIfErrorMs) return cached;
    return { unavailable: errorMessage(failure) };
  }

  /**
   * Refetches for a `kid` the cached document does not know, at most once
   * per `unknownKidRefetchCooldownMs` and never during a failure backoff.
   * Returns the document to look in afterwards.
   */
  async function refetchForUnknownKid(document: PreparedDocument): Promise<PreparedDocument> {
    if (staticDocument) return document;
    const now = clock();
    if (now - lastUnknownKidFetchAt < unknownKidCooldownMs) return document;
    if (lastFailure !== undefined && now - lastFailure.at < failureBackoffMs) return document;
    lastUnknownKidFetchAt = now;
    // On failure the kid stays unknown and the receipt fails with that
    // reason; `refetch` has already recorded the failure for the backoff.
    return refetch().then(
      (fresh) => fresh,
      () => document,
    );
  }

  async function check(input: SignatureInput): Promise<SignatureCheck> {
    if (!isReceiptAlgorithm(input.algorithm)) {
      return { valid: false, reason: `algorithm ${input.algorithm} is not supported` };
    }
    const current = await currentDocument();
    if ("unavailable" in current) {
      return { valid: false, reason: `key set unavailable: ${current.unavailable}` };
    }
    let prepared = current.keys.get(input.keyId);
    if (!prepared) {
      prepared = (await refetchForUnknownKid(current)).keys.get(input.keyId);
      if (!prepared) return { valid: false, reason: `unknown key ${input.keyId}` };
    }
    const { entry, key } = prepared;
    // The key record decides the algorithm (Issue #169). `Ed25519` on a
    // receipt and `EdDSA` on a record are the same algorithm.
    if (canonicalAlgorithm(entry.alg) !== canonicalAlgorithm(input.algorithm)) {
      return {
        valid: false,
        reason: `key ${entry.kid} is bound to ${entry.alg}, not ${input.algorithm}`,
      };
    }
    if (entry.status.state === "revoked") {
      // A compromised signer can backdate `issuedAt`, so a revoked key fails
      // every receipt it ever signed.
      return { valid: false, reason: `key ${entry.kid} is revoked` };
    }
    if (entry.status.state === "retired") {
      // A planned rotation: receipts issued strictly before `retiredAt`
      // still verify, later ones do not.
      const retiredMs = Date.parse(entry.status.retiredAt);
      const issuedMs = readIssuedAt(input.message);
      if (issuedMs === undefined) {
        return { valid: false, reason: `key ${entry.kid} is retired and issuedAt is unreadable` };
      }
      if (issuedMs >= retiredMs) {
        return {
          valid: false,
          reason: `key ${entry.kid} was retired at ${entry.status.retiredAt}, before this receipt was issued`,
        };
      }
    }
    const matches =
      entry.kty === "OKP"
        ? await verifyEd25519(key, input.signature, input.message)
        : await verifyEs256(key, input.signature, input.message);
    return matches ? { valid: true } : { valid: false, reason: "signature does not verify" };
  }

  return {
    check,
    async verify(input) {
      return (await check(input)).valid;
    },
    async refresh() {
      if (staticDocument) return;
      try {
        await refetch();
      } catch (error) {
        if (error instanceof TollwayError) throw error;
        throw new TollwayError("key-set-unavailable", errorMessage(error), { cause: error });
      }
    },
  };
}
