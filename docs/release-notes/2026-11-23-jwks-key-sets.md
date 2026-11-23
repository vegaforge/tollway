---
date: 2026-11-23
feature: JWKS-style receipt key sets with a caching key-set verifier
scope: feat
packages: [@vegaforge/tollway-core, @vegaforge/tollway-server]
scenario-impact: none
---

# Published receipt-signing keys and a caching key-set verifier

Services can now publish the public keys that sign their receipts in a
standard shape, and independent verifiers can fetch, cache, and rotate
them without sharing a codebase with the issuer.

The format is a JWK Set (RFC 7517) carrying Ed25519 keys as `kty: "OKP",
crv: "Ed25519"` (RFC 8037), extended with a Tollway-specific per-key
`status` field:

- `active` - in use.
- `retired` - a planned rotation. The key verifies receipts whose
  `issuedAt` is strictly before `retiredAt` and fails anything later.
- `revoked` - compromised. Every receipt it ever signed fails
  verification.

`Ed25519Signer` grew `fromJwk(jwk, keyId?)` and `publicJwk()`, so a
service can load a persisted private JWK and emit the matching public
JWK into a key-set document. The existing `fromPrivateKey` PKCS#8 path
is unchanged.

`renderKeySetResponse(document, { maxAgeSeconds })` in
`@vegaforge/tollway-server` returns a framework-agnostic `{ status,
headers, body }` object every adapter forwards; the recommended mount
path is `/.well-known/tollway-receipt-keys.jwks`.

`createKeySetVerifier({ url | document, fetch?, clock?, minCacheMs?,
maxCacheMs?, unknownKidRefetchCooldownMs? })` in
`@vegaforge/tollway-core` is a `ReceiptVerifier` that fetches and
caches the document, honours `Cache-Control: max-age` clamped between
`minCacheMs` and `maxCacheMs`, rate-limits refetches on an unknown
`kid` so a forged stream of receipts cannot force a fetch per attempt,
and fails closed when the document is unreachable without a cached
copy. It uses WebCrypto and `fetch` only, so it runs in Node 22+, edge
runtimes, and the browser.

`docs/receipt-format.md` now has a "Publishing keys" section with
step-by-step rotation and revocation procedures.

Closes #167.
