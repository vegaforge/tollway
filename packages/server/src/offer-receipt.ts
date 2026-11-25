import { bytesToBase64Url, type ReceiptSigner, type SignedReceipt } from "@vegaforge/tollway-core";
import type { PaymentRequirements } from "@x402/core/types";
import type {
  JWSSignedOffer,
  JWSSignedReceipt,
  JWSSigner,
  OfferPayload,
  ReceiptPayload,
} from "@x402/extensions/offer-receipt";
import { stellarCaip2 } from "./facilitator.js";

/**
 * The x402 offer-receipt extension, issued by the gate (#172).
 *
 * A route that opts in gets two extra signed statements, in the format
 * `@x402/extensions/offer-receipt` defines and reads:
 *
 * - an offer per `accepts[]` entry, in `PaymentRequired.extensions["offer-receipt"].info.offers`;
 * - a receipt on each settled x402 payment, in
 *   `SettleResponse.extensions["offer-receipt"].info.receipt` inside PAYMENT-RESPONSE.
 *
 * Both are JWS compact tokens signed with the service's `ReceiptSigner`. The
 * extension receipt is a delivery attestation with no amount, asset or model.
 * The Tollway receipt in TOLLWAY-RECEIPT stays the authoritative record; the
 * extension receipt is a projection of it. See docs/receipt-format.md,
 * "x402 offer-receipt extension".
 */

/** Key the extension uses in `extensions`; `OFFER_RECEIPT` in `@x402/extensions`. */
export const OFFER_RECEIPT_EXTENSION_KEY = "offer-receipt";

type OfferReceiptModule = typeof import("@x402/extensions/offer-receipt");
let offerReceiptModule: Promise<OfferReceiptModule> | undefined;

/**
 * Loads `@x402/extensions/offer-receipt` on first use. It pulls in `viem`,
 * `jose` and `@noble/curves` when evaluated, so a service that never opts
 * in never loads them. A failed load is not kept, so the next call retries.
 */
function loadOfferReceipt(): Promise<OfferReceiptModule> {
  if (!offerReceiptModule) {
    const loading = import("@x402/extensions/offer-receipt");
    offerReceiptModule = loading;
    loading.catch(() => {
      if (offerReceiptModule === loading) offerReceiptModule = undefined;
    });
  }
  return offerReceiptModule;
}

/** Signs a payload as a JWS with the library's own header and RFC 8785 canonical payload. */
async function createJWS(payload: object, signer: JWSSigner): Promise<string> {
  const { createJWS: libraryCreateJWS } = await loadOfferReceipt();
  return libraryCreateJWS(payload, signer);
}

/** The payload version `@x402/extensions` 2.31 writes and reads. */
const EXTENSION_VERSION = 1;

/** Most signed offers kept per gate. Older entries are evicted first. */
const OFFER_CACHE_LIMIT = 256;

/** Options for `PaywallConfig.offerReceipt`. `true` takes every default. */
export type OfferReceiptOptions = {
  /**
   * Put the settlement transaction hash in the extension receipt. Off by
   * default, as in `@x402/extensions`, because the hash links the payer's
   * account to the resource for anyone who sees the receipt.
   */
  includeTxHash?: boolean;
  /**
   * The JWS `kid`, a DID the client resolves to the verification key. Set
   * it to a `did:web` URL when the service publishes its keys (#167).
   * Defaults to a `did:key` (Ed25519) or `did:jwk` (P-256) derived from the
   * signer's public key. A signer that exposes neither must set it.
   */
  kid?: string;
  /**
   * How long a signed offer stays valid, in seconds. Defaults to the
   * route's `maxTimeoutSeconds`, and may not exceed it: the gate never
   * signs an offer that outlives its own acceptance window.
   */
  offerValiditySeconds?: number;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // Base conversion from 256 to 58, least significant digit first.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] as number) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i] as number];
  }
  return out;
}

/**
 * The `did:key` for a raw 32-byte Ed25519 public key: multicodec prefix
 * `0xed 0x01`, then multibase base58btc (`z`). `@x402/extensions` resolves
 * this form without any network call.
 */
export function didKeyFromEd25519PublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new TypeError(`an Ed25519 public key is 32 bytes, got ${publicKey.length}`);
  }
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);
  return `did:key:z${base58btc(prefixed)}`;
}

/** The `did:jwk` for a P-256 public key, from its JWK coordinates. */
function didJwkFromP256(x: string, y: string): string {
  // Members in lexicographic order, the RFC 7638 thumbprint convention.
  const jwk = JSON.stringify({ crv: "P-256", kty: "EC", x, y });
  return `did:jwk:${bytesToBase64Url(new TextEncoder().encode(jwk))}`;
}

/** Maps a Tollway signer algorithm to its JOSE `alg`, or undefined. */
function joseAlgorithm(algorithm: string): "EdDSA" | "ES256" | undefined {
  if (algorithm === "Ed25519" || algorithm === "EdDSA") return "EdDSA";
  if (algorithm === "ES256") return "ES256";
  return undefined;
}

/**
 * Derives a DID from the public key the core signers expose: `publicKey`
 * on `Ed25519Signer`, `publicJwkBytes` on `EcdsaP256Signer`. Read
 * structurally, so a signer from another copy of core still works.
 */
function derivedKid(signer: ReceiptSigner, alg: "EdDSA" | "ES256"): string | undefined {
  const exposed = signer as ReceiptSigner & {
    publicKey?: unknown;
    publicJwkBytes?: unknown;
  };
  if (alg === "EdDSA" && exposed.publicKey instanceof Uint8Array) {
    return exposed.publicKey.length === 32
      ? didKeyFromEd25519PublicKey(exposed.publicKey)
      : undefined;
  }
  if (alg === "ES256" && typeof exposed.publicJwkBytes === "object" && exposed.publicJwkBytes) {
    const { x, y } = exposed.publicJwkBytes as { x?: unknown; y?: unknown };
    if (typeof x === "string" && typeof y === "string") return didJwkFromP256(x, y);
  }
  return undefined;
}

/**
 * Adapts a Tollway `ReceiptSigner` to the extension's `JWSSigner`. The JWS
 * `alg` is `EdDSA` for Ed25519 and `ES256` for P-256; both core signers
 * already return the raw signature encoding JWS expects (64 bytes, and
 * `r || s` for P-256), which is base64url encoded here.
 *
 * Throws at construction, not at the first 402, for an algorithm JWS
 * cannot name or a signer whose `kid` cannot be derived and was not given.
 */
export function createOfferReceiptJwsSigner(signer: ReceiptSigner, kid?: string): JWSSigner {
  const alg = joseAlgorithm(signer.algorithm);
  if (!alg) {
    throw new TypeError(
      `offerReceipt: signer algorithm "${signer.algorithm}" has no JWS equivalent; use an Ed25519 or ES256 signer`,
    );
  }
  const resolvedKid = kid ?? derivedKid(signer, alg);
  if (!resolvedKid) {
    throw new TypeError(
      "offerReceipt: cannot derive a DID from this signer's public key; set offerReceipt.kid (for example a did:web URL)",
    );
  }
  if (!resolvedKid.startsWith("did:")) {
    throw new TypeError(`offerReceipt: kid must be a DID, got "${resolvedKid}"`);
  }
  return {
    kid: resolvedKid,
    format: "jws",
    algorithm: alg,
    async sign(payload) {
      return bytesToBase64Url(await signer.sign(payload));
    },
  };
}

/** The `extensions["offer-receipt"]` entry on a 402. */
export type OfferExtension = { info: { offers: JWSSignedOffer[] } };

/** The `extensions["offer-receipt"]` entry on a `SettleResponse`. */
export type ReceiptExtension = { info: { receipt: JWSSignedReceipt } };

/** What the gate holds for a route that opted in. */
export type OfferReceiptIssuer = {
  /** Signed offers for a 402's `accepts[]`, from the cache when still fresh. */
  offers(
    resourceUrl: string,
    requirements: readonly PaymentRequirements[],
    nowMs: number,
  ): Promise<OfferExtension>;
  /** The signed extension receipt for a settled Tollway receipt. */
  receipt(signed: SignedReceipt): Promise<ReceiptExtension>;
};

type CachedOffer = { validUntil: number; offer: Promise<JWSSignedOffer> };

/**
 * Builds the issuer for one route. `maxValiditySeconds` is the gate's own
 * acceptance window: the route's `maxTimeoutSeconds`, shortened to the
 * quote lifetime for a dynamic price.
 *
 * A signed offer is reused until less than half its validity remains, so
 * an unpaid-request flood costs one signature per requirement per half
 * window, not one per 402, and every offer handed out still has at least
 * half its window left. The cache key holds every signed field, so a
 * changed price or resource never reuses an offer.
 */
export function createOfferReceiptIssuer(
  signer: ReceiptSigner,
  options: OfferReceiptOptions,
  maxValiditySeconds: number,
): OfferReceiptIssuer {
  const validity = options.offerValiditySeconds ?? maxValiditySeconds;
  if (!Number.isSafeInteger(validity) || validity <= 0) {
    throw new TypeError("offerReceipt.offerValiditySeconds must be a positive integer");
  }
  if (validity > maxValiditySeconds) {
    throw new TypeError(
      `offerReceipt.offerValiditySeconds (${validity}) exceeds the gate's acceptance window of ${maxValiditySeconds} seconds`,
    );
  }
  const jwsSigner = createOfferReceiptJwsSigner(signer, options.kid);
  const includeTxHash = options.includeTxHash ?? false;
  const cache = new Map<string, CachedOffer>();

  function signOffer(
    resourceUrl: string,
    requirement: PaymentRequirements,
    acceptIndex: number,
    nowSeconds: number,
  ): CachedOffer {
    const payload: OfferPayload = {
      version: EXTENSION_VERSION,
      resourceUrl,
      scheme: requirement.scheme,
      network: requirement.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      amount: requirement.amount,
      validUntil: nowSeconds + validity,
    };
    const offer = createJWS(payload, jwsSigner).then(
      (signature): JWSSignedOffer => ({ format: "jws", acceptIndex, signature }),
    );
    return { validUntil: payload.validUntil, offer };
  }

  return {
    async offers(resourceUrl, requirements, nowMs) {
      const nowSeconds = Math.floor(nowMs / 1000);
      const offers = requirements.map((requirement, acceptIndex) => {
        const key = JSON.stringify([
          resourceUrl,
          acceptIndex,
          requirement.scheme,
          requirement.network,
          requirement.asset,
          requirement.payTo,
          requirement.amount,
        ]);
        const cached = cache.get(key);
        if (cached && (cached.validUntil - nowSeconds) * 2 > validity) {
          // Refresh the entry's place so the eviction order is least recently used.
          cache.delete(key);
          cache.set(key, cached);
          return cached.offer;
        }
        const fresh = signOffer(resourceUrl, requirement, acceptIndex, nowSeconds);
        cache.delete(key);
        cache.set(key, fresh);
        if (cache.size > OFFER_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        // A failed signature must not stay cached for the rest of the window.
        fresh.offer.catch(() => {
          if (cache.get(key) === fresh) cache.delete(key);
        });
        return fresh.offer;
      });
      return { info: { offers: await Promise.all(offers) } };
    },

    async receipt(signed) {
      const { receipt } = signed;
      const payload: Omit<ReceiptPayload, "transaction"> & { transaction?: string } = {
        version: EXTENSION_VERSION,
        network: stellarCaip2(receipt.network),
        resourceUrl: receipt.resource,
        payer: receipt.payer,
        // The Tollway receipt's own time, so a replayed receipt attests the
        // same moment the original did.
        issuedAt: Math.floor(Date.parse(receipt.issuedAt) / 1000),
      };
      if (includeTxHash && receipt.settlement.kind === "transaction") {
        payload.transaction = receipt.settlement.txHash;
      }
      return {
        info: { receipt: { format: "jws", signature: await createJWS(payload, jwsSigner) } },
      };
    },
  };
}
