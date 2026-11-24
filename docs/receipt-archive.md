# Replaying settled payments from the receipt archive

The settlement cache is short-lived on purpose (30 seconds by default). Before
#162, a retry of a payment that had settled but whose cache entry had expired
was handled like a new payment: `/verify` ran first, a real facilitator refused
the spent authorization, and the payer, who did pay, got a 402 and no receipt.
With `createMockFacilitator` the same payment was settled a second time.

A `PaymentReceiptArchive` is the durable record the gate replays from instead.

```ts
import {
  createPaywall,
  createRedisPaymentReceiptArchive,
  createRedisSettlementCache,
} from "@vegaforge/tollway-server";

const gate = createPaywall(config, {
  signer,
  facilitator,
  cache: createRedisSettlementCache({ client: redis }),
  receiptArchive: createRedisPaymentReceiptArchive({
    client: redis,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
  }),
  onCacheError: (error, key) => log.error({ error, key }, "settlement record write failed"),
  onArchiveError: (error, key) => log.warn({ error, key }, "receipt archive read failed"),
});
```

## How a retry is answered

1. The gate derives the payment key locally, with no network call:
   `<model>:<nonce>`, where the nonce is the SHA-256 of the signed transaction
   for x402 and of the credential payload for MPP charge. Facilitator clients
   and MPP handlers expose this as `idempotencyKey`.
2. It looks the key up in the settlement cache, then in the archive. Both
   lookups happen before local pre-validation and before `/verify`.
3. A hit goes through the same binding check as a cached receipt: the offer's
   resource, amount, asset, payee, network and model, and the HTTP method (and
   for a v2 receipt its `offerHash`). A hit for another offer is a 409
   `offer-mismatch`, never a replay.
4. A match is answered `settled` with `replayed: true` and the original receipt.
   Neither `/verify` nor `/settle` is called.

Every fresh settlement is written to the cache and the archive. Both writes are
awaited; a failure does not cost the payer the receipt but is set as
`cacheError` on the outcome and passed to `onCacheError`. A `/settle` that
answers after its deadline is written to both as well.

## What possession of a settled payment grants

The key is a digest of the exact signed payment bytes, so only someone holding
those bytes can match it. Holding them grants re-delivery of the resource that
payment bought, for the same offer and the same HTTP method, for as long as the
archive keeps the entry. That is the grant the settlement cache already made
for its 30 seconds; the archive extends its duration, not its scope.

- The payer has the bytes, and getting the resource again for a payment that
  settled is the point.
- Anyone the bytes leak to (a log, a proxy, a shared debugging session) can
  fetch that one resource again, without paying, until the entry expires. They
  cannot use the bytes for another route, price or method, and cannot settle
  them a second time: on chain the authorization is spent.
- Moving the lookup before `/verify` means the facilitator no longer sees
  retries of settled payments. That is the intended effect; a payment that
  never settled is never in the archive, so it still goes through `/verify`.

Treat `PAYMENT-SIGNATURE` values like bearer tokens for the resource they paid
for: keep them out of logs.

## Choosing a retention

- No retention (the Redis default): every settled payment replays forever. Use
  it when resources are cheap to serve again and storage is not a concern.
- A retention at least as long as clients may retry, for example a day or a
  week: bounds storage and the window in which leaked payment bytes are useful.
  After it expires the payment behaves as before #162 (a real facilitator
  refuses the spent authorization with a 402).
- The in-memory archive also caps entries (100 000 by default) and forgets
  everything on restart, so it suits a single long-lived process only. Use the
  Redis archive when more than one process serves the route.

Do not lengthen the settlement cache TTL instead: its short window is what
bounds the cross-process lock and the hold logic.

## When the archive fails

- A failed read is passed to `onArchiveError`, and the request continues to
  `/verify` as if the archive had no entry. The facilitator refuses a spent
  authorization, so nothing is charged twice, but the payer may get a 402
  instead of the replay until the archive recovers.
- A failed write after settlement is reported through `cacheError` and
  `onCacheError`; the receipt is still returned.
- Entries read from Redis are checked against the signed receipt schema. A
  corrupted or foreign value is a miss.

This archive is only the replay seam. The searchable receipt archive in
`@vegaforge/tollway-observability` (#222) answers queries, and a tamper-evident
log is #171; either can implement `PaymentReceiptArchive` as well.
