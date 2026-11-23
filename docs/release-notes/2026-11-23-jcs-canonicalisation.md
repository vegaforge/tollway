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

Validation happens in the same pass as serialisation, and the path to a
refused value is only built when something is refused, so canonicalising
a valid receipt costs about what it did before.

A new vectors file at `docs/receipt-vectors/canonical-and-ed25519.json`
publishes canonical and signature vectors: an empty object, nested
sorting, arrays, a supplementary-plane character, a UTF-16 key-order case
with U+FB33, the RFC 8785 section 3.2.3 and 3.2.2.2 examples, and a v1
receipt body. They are signed with the RFC 8032 section 7.1 TEST 2
Ed25519 key; `es256Vectors` add verify-only ES256 vectors (#169). Every
non-ASCII character in the file is a `\u` escape, so no editor can
normalise it. The keys are published and insecure on purpose.
`packages/core/src/receipt/vectors.test.ts` loads the file and asserts
canonical bytes and signatures against the implementation, so the two
cannot drift.

The RFC 8785 Appendix B number samples and the section 3.2.3 and
3.2.2.2 examples are unit tests. A property test compares the new
serialiser with the one before #165 over generated v1 receipt bodies and
JSON values, and finds identical bytes for every input without a lone
surrogate; another property checks that a lone surrogate anywhere is
refused.

For receipts: every schema-valid v1 receipt that contains no lone
surrogate signs and verifies byte-for-byte identically to how it did
before. A receipt whose `resource` or similar string carried a lone
surrogate would be rejected at `buildReceipt`; verifying such a receipt
if one already exists on disk is unchanged.

Pull request: #327.

Closes #165.
