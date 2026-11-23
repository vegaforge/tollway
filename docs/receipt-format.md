# Receipt format reference

Every settlement path in Tollway, regardless of model, ends in exactly one canonical shape: a signed receipt. x402 per-request, MPP charge, and MPP channel commitments all converge here. Downstream accounting, dispute evidence, and analytics consume one shape instead of three. This document describes every field, the settlement-reference variants, and how signing and verification work.

Source of truth: `packages/core/src/receipt/schema.ts` (the zod schemas), `packages/core/src/receipt/receipt.ts` (`buildReceipt`, `signReceipt`, `verifyReceipt`), and `packages/core/src/receipt/signer.ts` (the signer / verifier interfaces and the default Ed25519 implementation). See also `docs/design.md`, "One receipt format".

## Shape at a glance

A signed receipt is two parts: the receipt body and a detached signature over the body's canonical bytes.

```ts
type SignedReceipt = {
  receipt: ReceiptBody;
  signature: ReceiptSignature;
};
```

A worked example:

```json
{
  "receipt": {
    "version": 1,
    "id": "5b8c4d8e-2a3a-4f1d-9d0a-3a5b6c7d8e9f",
    "payer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "payee": "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "amount": "10000",
    "asset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "resource": "/quotes/latest",
    "model": "x402",
    "settlement": {
      "kind": "transaction",
      "txHash": "ad21ce4f9e1f3b2a8e7c0d1f2a3b4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5"
    },
    "network": "testnet",
    "issuedAt": "2026-06-29T14:00:00.000Z"
  },
  "signature": {
    "keyId": "tollway-2026-q2",
    "algorithm": "Ed25519",
    "value": "5p_aP3LE6QwrXSm2eYU7C4...m1nQ"
  }
}
```

## The receipt body

Field by field, in the order the schema declares them.

### `version: 1 | 2`

Schema version. Version 1 is the format described field by field below; version 2 adds three fields (see "Receipt v2"). The schema is a union discriminated on `version`, so a body is checked against exactly one layout. A verifier that does not recognize a version returns invalid rather than guessing the layout.

### `id: string`

Unique per receipt. The signature covers the id, so a replayed receipt is detectable as a duplicate at the same `(payer, resource, txHash)` triple. `buildReceipt` defaults this to a fresh `crypto.randomUUID()` when none is supplied.

### `payer: string`

The agent that authorized the payment. A Stellar account id (`G...`) in every Stellar settlement model today; the type is a non-empty string so non-Stellar paths can fit in if Tollway ever grows them.

### `payee: string`

The service that received the payment. Tollway never sits between counterparties: the on-chain settlement goes directly to this address.

### `amount: string`

Integer string in the asset's smallest unit. A string, not a number, because JavaScript numbers lose precision past 2<sup>53</sup>; receipts have to round-trip through JSON without rounding. The schema rejects anything that does not match `/^[0-9]+$/`.

### `asset: string`

The asset code, qualified for unambiguous identification. The canonical Stellar shape is `CODE:ISSUER` (e.g. `USDC:GA5Z...`); the type is a non-empty string so other forms (XLM, custom codes) are valid too.

### `resource: string`

The URL or stable identifier of what was paid for. For HTTP gates this is the request path the gate sees (`/quotes/latest`); for non-HTTP gates it can be any opaque resource id. The gate config can override the default (`req.url`) via `PaywallConfig.resource`.

### `model: "x402" | "mpp-charge" | "mpp-channel"`

Which settlement model produced this receipt. The schema enforces a coherence rule with the settlement reference (see below): an `x402` receipt with a `channel-commitment` reference is malformed no matter who signed it.

### `settlement: SettlementRef`

How the payment is anchored on chain. A discriminated union with two variants; see the next section.

### `network: "testnet" | "mainnet"`

Which Stellar network the settlement landed on. Receipts from testnet and mainnet should be stored and compared separately; the network is on the receipt so audit trails do not need a side channel for it.

### `issuedAt: string`

ISO 8601 timestamp of when the receipt was issued. Defaults to `new Date().toISOString()` when `buildReceipt` is called without an override.

## Receipt v2

A v2 receipt carries everything a v1 receipt does, plus three fields that bind it to the exact offer the payer accepted (Issue #166):

- `offerHash: string`: the base64url SHA-256 of the RFC 8785 canonical bytes of the offer as the challenge sent it: `resource`, `amount`, `asset`, `payTo`, `network`, `models` (in order), and `mppSessionSupported`, `facilitatorUrl` and `quote` when present. Two offers for the same URL and price that differ in their models list or facilitator produce different hashes. `hashOffer(offer)` from `@vegaforge/tollway-core` is the one function that computes it; the gate and verifiers both use it.
- `method: string`: the HTTP method of the paid request, uppercase (`GET`, `POST`). A receipt for `GET /x` does not unlock `POST /x`.
- `expiresAt?: string`: an ISO 8601 time strictly after `issuedAt`. It says how long the receipt is honoured as proof of access; it has nothing to do with the settlement cache. A receipt without it never expires.

`verifyReceipt(candidate, verifier, { now })` checks the signature first and then the expiry, so `"receipt expired"` is only ever reported for a receipt the trusted key really signed. `now` defaults to the current time.

`buildReceipt` returns a v2 body when it is given both `offerHash` and `method`, and a v1 body when it is given neither. Supplying only one of them throws `invalid-receipt`, so a v2 field is never dropped silently.

### Switching a gate to v2

The gate issues v1 receipts until the operator sets `receiptVersion: 2` in the `createPaywall` dependencies. The switch is explicit because of rolling deploys: a process from before v2 reads a cached v2 receipt as a cache miss, and would call `/settle` again for a payment that already settled. The safe order is:

1. Deploy the version that understands v2 to every process, with `receiptVersion` unset. These processes read v1 and v2 cache entries and still issue v1.
2. Wait until no older process serves traffic or shares the settlement cache.
3. Set `receiptVersion: 2` and deploy again.

After the switch, v1 receipts already in the cache are still served to retries of their payments. A cached v2 receipt is served only when its `offerHash` and `method` match the request's offer, on top of the six fields a v1 receipt is bound by.

## Settlement reference variants

```ts
type SettlementRef =
  | { kind: "transaction"; txHash: string }
  | { kind: "channel-commitment"; channelId: string; sequence: number };
```

The model determines which variant is valid:

| Model         | Settlement variant         | Why |
| ------------- | -------------------------- | --- |
| `x402`        | `transaction`              | One on-chain settlement per request. |
| `mpp-charge`  | `transaction`              | Same as x402 from a settlement-reference standpoint; the difference is in the verify / settle protocol. |
| `mpp-channel` | `channel-commitment`       | Many off-chain commitments per channel; the `sequence` pins this commitment within the cumulative stream. |

`schema.ts` enforces this with a `superRefine` that rejects mismatched combinations. A channel receipt with a `txHash` (or an x402 receipt with a `channelId` + `sequence`) fails validation before the signature is even checked.

## The signature

```ts
type ReceiptSignature = {
  keyId: string;
  algorithm: string;
  value: string;
};
```

`keyId` identifies the signing key, so keys can rotate without orphaning past receipts. `algorithm` names the signature scheme. `value` is the base64url-encoded signature over the canonical bytes of the receipt body.

### Algorithms

The supported identifiers are defined once, as `RECEIPT_ALGORITHMS` in `packages/core/src/receipt/algorithms.ts`:

| Identifier | Algorithm | Signature on the wire |
| ---------- | --------- | --------------------- |
| `Ed25519` | Ed25519 (RFC 8032). The value receipts have carried since v1, and what `Ed25519Signer` writes. | 64 bytes, base64url |
| `EdDSA` | The JOSE name (RFC 8037) for the same algorithm. Key-set entries use it in `alg`, and verifiers treat the two spellings alike. | 64 bytes, base64url |
| `ES256` | ECDSA over P-256 with SHA-256 (Issue #169). | IEEE P1363 `r \|\| s`, 64 bytes, base64url, with `s` in the low half |

Any other identifier, `none` included, fails verification with a reason. It never throws.

ECDSA accepts both `s` and `n - s` for the same message, so Tollway signs with the low half and verifiers refuse the high half: each receipt has exactly one valid signature. Most KMS and HSM APIs return ASN.1 DER instead of P1363. `derToP1363(der)` converts it, and is strict: it refuses trailing bytes, non-minimal lengths and integers, negative integers, and an `r` or `s` that is zero or not below the P-256 order, all with `invalid-signature-encoding`. Pass the result through `normaliseLowS` before publishing it.

### Canonical bytes

The signature covers a deterministic serialization of the receipt body that conforms to [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) (JSON Canonicalization Scheme, JCS). Keys are sorted at every nesting level by UTF-16 code units (section 3.2.3), numbers are formatted with the ECMAScript `ToString(Number)` algorithm (section 3.2.2.3), only control characters, `"` and `\` are escaped (section 3.2.2.2), and `undefined` properties on objects are dropped the same way `JSON.stringify` drops them. Two structurally equal values always produce the same bytes, which is what makes signatures reproducible across runtimes and across languages. See `packages/core/src/receipt/canonical.ts`.

JCS requires I-JSON input ([RFC 7493](https://www.rfc-editor.org/rfc/rfc7493)): lone surrogates are forbidden, and inputs JSON cannot represent (`bigint`, functions, symbols, `undefined` inside an array) are not allowed. `canonicalJson` throws `TollwayError("canonicalization-failed", ...)` for any of these at `buildReceipt` time. Non-plain objects (a `Date`, a class instance, a `Map`) are rejected for the same reason: `JSON.stringify` would silently render them as `{}` and the signer would then sign something that did not round-trip.

### Verifying in another language

A verifier in Go, Rust, Python, or anywhere else can check its canonicalisation and its signature verification against the published test vectors at [`docs/receipt-vectors/canonical-and-ed25519.json`](receipt-vectors/canonical-and-ed25519.json).

- `vectors` carry the input JSON, the expected canonical UTF-8 (as text and as hex), and the Ed25519 signature made with the published RFC 8032 section 7.1 TEST 2 private key. Ed25519 signatures are deterministic, so a conforming implementation reproduces every signature byte for byte. They include the RFC 8785 section 3.2.3 key-ordering example and the section 3.2.2.2 string-escaping example.
- `es256Vectors` carry an input, its canonical bytes, and an ES256 signature made with the published RFC 6979 appendix A.2.5 P-256 key. ECDSA signatures are randomised, so these are verify-only: check the signature, do not expect to reproduce it.

Every non-ASCII character in the file is written as a `\u` escape. Read the file with a JSON parser, not as text: an editor that saves it as raw UTF-8 could normalise characters such as U+FB33, which is the case the key-ordering vector exists to test. Both keys are published and insecure on purpose: nothing in the file is a real signing secret. `packages/core/src/receipt/vectors.test.ts` keeps the vectors and the implementation in step.

## Signing

Signing sits behind an interface so the key can live wherever a deployment needs it: in process, in a KMS, in an HSM.

```ts
interface ReceiptSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}
```

The default implementation is `Ed25519Signer`, which uses WebCrypto and therefore runs in both Node and edge runtimes:

```ts
import { Ed25519Signer, buildReceipt, signReceipt } from "@vegaforge/tollway-core";

const signer = await Ed25519Signer.generate("tollway-2026-q2");

const receipt = await signReceipt(
  buildReceipt({
    payer: "GA5Z...",
    payee: "GSERVICE...",
    amount: "10000",
    asset: "USDC:GA5Z...",
    resource: "/quotes/latest",
    model: "x402",
    settlement: { kind: "transaction", txHash: "ad21..." },
    network: "testnet",
  }),
  signer,
);
```

`buildReceipt` validates the body and fills in `version`, `id`, and `issuedAt` if they are not supplied. `signReceipt` produces the canonical bytes, signs them, and returns a `SignedReceipt` with the signer's `keyId` and `algorithm` attached.

### Swapping the signer

Any object that satisfies the `ReceiptSigner` interface is a valid signer. A KMS-backed signer that delegates `sign` to AWS KMS, GCP KMS, or an HSM is a drop-in replacement; the rest of the system does not change. The only requirements are that `keyId` is stable for the lifetime of the key and `algorithm` matches what a downstream verifier knows.

## Verifying

```ts
type SignatureInput = {
  message: Uint8Array;
  signature: Uint8Array;
  keyId: string;
  algorithm: string;
};

interface ReceiptVerifier {
  verify(input: SignatureInput): Promise<boolean>;
  // Optional: says why a signature fails.
  check?(input: SignatureInput): Promise<{ valid: true } | { valid: false; reason: string }>;
}
```

`verifyReceipt(candidate, verifier)` accepts `unknown` on purpose: receipts arrive over the wire and the schema is the gate. It runs `signedReceiptSchema.safeParse(candidate)` first, then asks the verifier to check the signature, through `check` when the verifier has one, so the result carries the verifier's reason (for example `"key k1 is revoked"`). It never throws: a signature that is not base64url, or a verifier that throws, comes back as an invalid result with a reason. The schemas are strict: a field anywhere in the receipt that the signature does not cover makes the receipt invalid. A valid result carries the parsed receipt as `result.receipt`; use that value from then on, not the object you passed in.

```ts
import { Ed25519Verifier, verifyReceipt } from "@vegaforge/tollway-core";

const verifier = new Ed25519Verifier({
  "tollway-2026-q2": signerPublicKeyBytes,
});

const result = await verifyReceipt(incomingReceipt, verifier);
if (!result.valid) {
  throw new Error(`receipt rejected: ${result.reason}`);
}
const trusted = result.receipt; // exactly what the signature covers
```

`Ed25519Verifier.forSigner(signer)` is a convenience constructor for the single-key case: it builds a verifier that trusts the signer's own public key.

### Key rotation

The signature carries `keyId`, and `Ed25519Verifier` accepts a map of `keyId -> publicKey`. Rotation is therefore additive: when a new key is introduced, both the old and the new public key live in the verifier's map until every receipt signed by the old key has aged out of the window you care about (the settlement cache, the dispute window, the audit retention period). New receipts use the new `keyId`; old receipts still verify against the old key. An unknown `keyId` or a different `algorithm` returns false rather than throwing, so a verifier that does not have the key configured fails closed.

The same property makes multi-signer deployments straightforward: every Tollway instance can have its own `keyId`, and every downstream service can trust the set of instance keys it expects to see.

## Publishing keys

Independent verifiers that do not share a codebase with the issuer need a way to fetch the trusted public keys. Tollway publishes them as a JWK Set (RFC 7517) with Ed25519 keys in `kty: "OKP", crv: "Ed25519"` form (RFC 8037) and P-256 keys in `kty: "EC", crv: "P-256"` form, plus a Tollway-specific per-key `status` field. Each entry's `alg` (`EdDSA` or `ES256`) decides how its key is used: a receipt whose `signature.algorithm` names a different algorithm fails, so an Ed25519 key never checks an ES256 signature, or the reverse. Every `kid` in a document must be unique, and key material is checked when the document is parsed (32 bytes for an Ed25519 `x`, 32 bytes each for a P-256 `x` and `y`, and a point on the curve).

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
      "kid": "tollway-2026-q2",
      "alg": "EdDSA",
      "use": "sig",
      "status": { "state": "active" }
    },
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "B1ffj5YQAtQr6ue3dFlc7wDlAbhG3E9bmgXflytbMvs",
      "kid": "tollway-2026-q1",
      "alg": "EdDSA",
      "use": "sig",
      "status": { "state": "retired", "retiredAt": "2026-07-01T00:00:00.000Z" }
    }
  ]
}
```

`status.state` is one of:

- `active`: the key is in use.
- `retired`: a planned rotation. The key verifies receipts whose `issuedAt` is strictly before `retiredAt` and fails anything later. Keep a retired key in the document until every receipt signed by it has aged out of your audit window.
- `revoked`: the key is compromised. Every receipt it ever signed fails verification, because a compromised signer can backdate `issuedAt` and there is no honest cutoff.

### Serving the document

`renderKeySetResponse(document, { maxAgeSeconds })` in `@vegaforge/tollway-server` returns a framework-agnostic `{ status, headers, body }` object the four adapters (Express, Fastify, Next, Hono) can forward. The recommended mount path is `/.well-known/tollway-receipt-keys.jwks`:

```ts
import { renderKeySetResponse } from "@vegaforge/tollway-server";

const response = renderKeySetResponse(
  { keys: [{ ...signer.publicJwk(), status: { state: "active" } }] },
  { maxAgeSeconds: 300 },
);
// response.status === 200
// response.headers["content-type"] === "application/jwk-set+json"
// response.headers["cache-control"]  === "public, max-age=300"
// response.body is the JSON a verifier parses
```

### Loading persisted keys

`Ed25519Signer.fromPrivateKey(encodedKey, keyId?)` loads a 32-byte seed or a 48-byte PKCS#8 document (what `openssl genpkey -algorithm ed25519 -outform DER` produces). `Ed25519Signer.fromJwk(jwk, keyId?)` loads a private JWK (`{ kty: "OKP", crv: "Ed25519", d, x }`), which is what most managed-key services export. For P-256, `EcdsaP256Signer.fromPkcs8(der, keyId?)` takes PKCS#8 DER as bytes or base64url, and `EcdsaP256Signer.fromJwk(jwk, keyId?)` takes a private JWK. `signer.publicJwk()` returns the public half in the shape the key-set document expects.

### Caching key-set verifier

Downstream verifiers call `createKeySetVerifier({ url })` to point at a service's key-set URL, or `createKeySetVerifier({ document })` for a key set loaded at boot. It implements `ReceiptVerifier` with `check`, so `verifyReceipt` reports why a receipt failed: an unknown key, an algorithm the key is not bound to, a revoked key, a retired key past its cutoff, a signature that does not verify, or a key set that cannot be read. It never throws during verification. Only the configured URL is ever fetched; a URL taken from a receipt is never followed, so a forged receipt cannot steer the verifier.

| Option | Default | What it does |
| ------ | ------- | ------------ |
| `minCacheMs` | 10 seconds | Shortest time a fetched document is cached, whatever `max-age` says. |
| `maxCacheMs` | 1 hour | Longest time a fetched document is cached, whatever `max-age` says. |
| `defaultCacheMs` | 5 minutes | Cache lifetime when the response has no `max-age`, clamped between the two above. |
| `staleIfErrorMs` | 0 | How long an expired copy may still be used while refetching fails. |
| `failureBackoffMs` | 30 seconds | After a failed fetch, no new fetch for this long, so a key-set URL that is down is not hit once per receipt. |
| `unknownKidRefetchCooldownMs` | 60 seconds | Shortest interval between refetches caused by a receipt naming a `kid` the cached document does not have. |

A document's own `expiresAt`, when present, also caps its cache lifetime.

When the cached copy expires, the verifier refetches. If that fails, the expired copy is used for at most `staleIfErrorMs`, and after that every receipt fails with `"key set unavailable"`: the verifier fails closed. That bounds how long a revocation can go unseen. With the cache lifetime `L` (the response's `max-age`, or `defaultCacheMs` without one, clamped between `minCacheMs` and `maxCacheMs`), a verifier sees a revocation at most `L + staleIfErrorMs` after the document is updated. With the defaults and the server helper's `max-age=300`, that is five minutes.

`refresh()` fetches the document now, ignoring the cache lifetime and the cooldowns. On failure it throws `key-set-unavailable` and keeps the cached copy. On a verifier built from a `document`, it does nothing.

```ts
import { createKeySetVerifier, verifyReceipt } from "@vegaforge/tollway-core";

const verifier = createKeySetVerifier({
  url: "https://api.example.com/.well-known/tollway-receipt-keys.jwks",
});

const result = await verifyReceipt(incoming, verifier);
if (!result.valid) console.warn(result.reason); // for example "key tollway-2026-q1 is revoked"
```

### Rotation and revocation procedures

Rotation (planned):

1. Generate a new key and publish it with `status: { state: "active" }` alongside the current one. Give it a few `max-age` windows for verifiers to pick it up.
2. Switch the signer over to the new key.
3. Mark the previous key `status: { state: "retired", retiredAt: <now> }`. It keeps verifying older receipts; new receipts are issued by the new key.
4. Keep the retired entry in the document until every retired-key receipt has aged past your audit window.

Revocation (incident):

1. Mark the compromised key `status: { state: "revoked" }`. Every receipt it ever signed now fails verification, including past ones.
2. Deploy a new key the same way as a planned rotation.
3. Communicate the incident separately. A verifier that cached the document before the revocation sees it within one cache lifetime plus its `staleIfErrorMs` (see "Caching key-set verifier"); with Tollway's defaults that is five minutes. State that window in the incident notice.
