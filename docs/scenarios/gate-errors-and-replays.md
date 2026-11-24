# Read gate errors, refused payments and late replays

1. Point any adapter at a gate whose facilitator URL refuses connections and
   send a well-formed payment. Expect `503` with body
   `{ "error": { "code": "facilitator-unavailable", ... } }` and `Retry-After: 1`,
   in every framework. The four adapter suites run every code
   (`packages/adapter-*/src/error-conformance.test.ts`).
2. Send a payment whose Stellar transaction pays another account. Expect `402`
   `payment-invalid` with `upstreamReason`
   `invalid_exact_stellar_payload_wrong_recipient` and no `/verify` call at the
   facilitator. Automated in `packages/server/src/gate-prevalidation.test.ts`.
3. With `receiptArchive` configured, pay once, wait past the settlement cache
   TTL (30 s by default), and resend the same payment. Expect `200` with the
   original receipt and no facilitator call. Automated with a fake clock in
   `packages/server/src/gate-receipt-archive.test.ts`.
