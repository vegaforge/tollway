---
date: 2026-11-23
feature: RFC 8785 (JCS) canonicalisation with published test vectors
scope: feat
packages: [@vegaforge/tollway-core]
scenario-impact: none
---

# JCS canonicalisation and receipt test vectors

`canonicalJson` and `canonicalBytes` in `@vegaforge/tollway-core` now
conform to RFC 8785, the JSON Canonicalization Scheme. The module-doc
comment and `docs/receipt-format.md` name the standard and spell out the
I-JSON input requirements so a verifier in another language has an
authoritative reference. Key order (UTF-16 code units), number formatting
(ECMA-262 `ToString(Number)`) and string escaping (only control chars,
`"` and `\`) were already correct; what changes is the input validation:

- Lone high or low surrogates in a string value or an object key throw
  `TollwayError("canonicalization-failed", ...)` instead of being
  silently emitted (they are invalid I-JSON and a conforming JCS
  verifier elsewhere would reject them).
- `undefined` inside an array throws `TollwayError("canonicalization-failed", ...)`
  instead of surfacing a raw `TypeError`.
- Non-plain objects (`Date`, class instances, `Map`, `RegExp`) throw
  `TollwayError("canonicalization-failed", ...)` instead of silently
  rendering as `{}`.
- `bigint`, functions and symbols throw with named paths.

A new vectors file at `docs/receipt-vectors/canonical-and-ed25519.json`
publishes six canonical / signature vectors (covering an empty object,
nested sorting, arrays, a supplementary-plane character, the RFC 8785
section 3.2.3 key-order example, and a v1 receipt body) signed with the
RFC 8032 section 7.1 TEST 2 Ed25519 private key. The key is published
and insecure on purpose. `packages/core/src/receipt/vectors.test.ts`
loads the file and asserts both canonical bytes and signatures against
the implementation, so the two cannot drift.

For receipts: every schema-valid v1 receipt that contains no lone
surrogate signs and verifies byte-for-byte identically to how it did
before. A receipt whose `resource` or similar string carried a lone
surrogate would be rejected at `buildReceipt`; verifying such a receipt
if one already exists on disk is unchanged.

Closes #165.
