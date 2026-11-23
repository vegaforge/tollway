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
crv: "Ed25519"` (RFC 8037) and P-256 keys as `kty: "EC", crv: "P-256"`,
extended with a Tollway-specific per-key `status` field:

- `active`: in use.
- `retired`: a planned rotation. The key verifies receipts whose
  `issuedAt` is strictly before `retiredAt` and fails anything later.
- `revoked`: compromised. Every receipt it ever signed fails
  verification.

Every `kid` in a document must be unique, and key material is checked
when the document is parsed (lengths, and that each key imports).
`parseKeySetDocument` throws `invalid-key-set` with every issue.

`Ed25519Signer` grew `fromJwk(jwk, keyId?)` and `publicJwk()`, so a
service can load a persisted private JWK and emit the matching public
JWK into a key-set document. The existing `fromPrivateKey` PKCS#8 path
is unchanged.

`renderKeySetResponse(document, { maxAgeSeconds })` in
`@vegaforge/tollway-server` returns a framework-agnostic `{ status,
headers, body }` object every adapter forwards; the recommended mount
path is `/.well-known/tollway-receipt-keys.jwks`.

`createKeySetVerifier({ url | document })` in `@vegaforge/tollway-core`
is a `ReceiptVerifier` that fetches and caches the document. It honours
`Cache-Control: max-age` clamped between `minCacheMs` (10 seconds) and
`maxCacheMs` (1 hour), with `defaultCacheMs` (5 minutes) when there is
no `max-age`. Once the cached copy expires and a refetch fails, it keeps
using the old copy for at most `staleIfErrorMs` (0 by default) and then
fails closed, so a revocation is seen within one cache lifetime plus
`staleIfErrorMs`. After a failed fetch it waits `failureBackoffMs` (30
seconds) before fetching again, and an unknown `kid` refetches at most
once per `unknownKidRefetchCooldownMs` (60 seconds), so neither an
outage nor a stream of forged receipts turns into one fetch per receipt.

The verifier implements a new optional `check` method on
`ReceiptVerifier`, which `verifyReceipt` uses to report why a receipt
failed: an unknown key, an algorithm the key is not bound to, a revoked
key, a retired key past its cutoff, a bad signature, or an unreachable
key set. Verification never throws. `refresh()` fetches now; on failure
it throws `key-set-unavailable` and keeps the cached copy, and on a
verifier built from a `document` it does nothing. It uses WebCrypto and
`fetch` only, so it runs in Node 22+, edge runtimes, and the browser.

New error codes: `invalid-key-set` and `key-set-unavailable`.
`renderKeySetResponse` refuses an invalid document or `maxAgeSeconds`
with `invalid-key-set`. An adapter test mounts it through Hono and
verifies a receipt against the served document.

`docs/receipt-format.md` now has a "Publishing keys" section with
step-by-step rotation and revocation procedures.

Pull request: #327.

Closes #167.
