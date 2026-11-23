# @vegaforge/tollway-client

The agent side of Tollway. `createClient` runs the policy check, asks the
router which settlement model to use, delegates signing and submission to an
injected settler, verifies the receipt, and records the spend. Every receipt
can be persisted in a receipt store, so an agent can answer "what did I pay
for, and how much have I spent per service, asset and model".

See [docs/design.md](https://github.com/vegaforge/tollway/blob/dev/docs/design.md)
for how the pieces fit together.

## Install

```bash
pnpm add @vegaforge/tollway-client @vegaforge/tollway-core
```

The main entry is runtime-agnostic. The SQLite store lives in a subpath,
`@vegaforge/tollway-client/sqlite`, and needs Node 22.13 or later because it
uses the built-in `node:sqlite` module. Node 22 and 24 still print an
`ExperimentalWarning` the first time that module loads.

## Pay for a resource

```ts
import { Ed25519Verifier } from "@vegaforge/tollway-core";
import { createClient, createMemoryReceiptStore } from "@vegaforge/tollway-client";

const store = createMemoryReceiptStore();

const client = createClient({
  network: "testnet",
  settler, // your ClientSettler: signs and submits the payment
  verifier: new Ed25519Verifier({ "service-key": publicKey }),
  receiptStore: store,
  onStoreError: (error, receipt) => {
    // The payment settled; only the bookkeeping failed. Alert and continue.
    logger.error({ error, receiptId: receipt.receipt.id }, "receipt store write failed");
  },
});

const { receipt, storeError } = await client.pay({
  resource: "/quotes/latest",
  offer,
});
```

`pay()` resolves with the receipt as soon as the payment has settled and the
receipt has been verified. When a store is configured, the store write is
awaited before that happens.


## Settlers

Two settlers ship with the package, one per per-request model:

- `createX402Settler({ signer, network })` pays x402 V2 routes with `@x402/stellar`.
- `createMppChargeSettler({ secretKey | keypair, network, mode? })` pays MPP charge routes with `@stellar/mpp`. It refuses a challenge unless the amount, recipient, token contract and network match the approved offer, and nothing is signed until they do. In `pull` mode (the default) the service submits the transaction and pays the fee; in `push` mode the agent submits it, so its account also needs XLM. It never patches `globalThis.fetch`.

Both read the Tollway receipt from the `TOLLWAY-RECEIPT` header.

## Receipt store

```ts
interface ReceiptStore {
  put(receipt: SignedReceipt): Promise<void>;
  get(id: string): Promise<SignedReceipt | null>;
  query(filter?: ReceiptFilter, page?: ReceiptQueryPage): Promise<ReceiptQueryResult>;
}
```

- `put` is idempotent by `receipt.receipt.id`: storing the same receipt twice
  leaves one receipt, and the first write wins.
- `get` returns `null` for an id the store has never seen.
- `query` filters by `payee`, `asset`, `model`, `resource`, `from` and `to`
  (inclusive bounds on `issuedAt`) and returns receipts newest first, ordered
  by `issuedAt` and then `id`, both descending.

### Pagination

`query({}, { limit: 100 })` returns `{ items, nextCursor }`. Pass
`nextCursor` back as `cursor` to read the next page. The cursor is an opaque
base64url keyset on `(issuedAt, id)`, so pages stay stable while new receipts
arrive. A value the store did not produce, including an edited one, is
rejected with a `TollwayError` whose code is `invalid-cursor`. `limit` must be
an integer from 1 to 1000.

```ts
let cursor: string | undefined;
do {
  const page = await store.query({ payee: servicePayee }, { limit: 200, cursor });
  for (const receipt of page.items) report(receipt);
  cursor = page.nextCursor;
} while (cursor);
```

## Spend ledger

The store also answers spend questions over what it holds:

```ts
const totals = await store.totals({ from: "2026-11-01T00:00:00.000Z" });
totals.byPayeeAsset;
// [{ payee: "GSERVICE1", asset: "USDC:GA5Z", amount: "1250", count: 2 }]
totals.byModelAsset;
// [{ model: "x402", asset: "USDC:GA5Z", amount: "1000", count: 1 }, ...]
```

Amounts are integer strings in the asset's smallest unit, summed with
`bigint`, so an amount past `Number.MAX_SAFE_INTEGER` stays exact. Every total
is per asset: a USDC amount and a native XLM amount are never added together.
`totals` accepts the same `payee`, `asset`, `model`, `from` and `to` filters
as `query`, except `resource`.

The ledger is computed from stored receipts. It does not read the policy
engine's in-process spend maps, so its history survives a restart and does not
stop at the policy window.

## SQLite store

```ts
import { createSqliteReceiptStore } from "@vegaforge/tollway-client/sqlite";

const store = createSqliteReceiptStore({ path: "./agent-receipts.db" });
// ... use it as the client's receiptStore, and for ledger queries
store.close(); // release the file handle
```

The schema keeps the signed receipt as JSON next to the indexed fields
queries need: `issuedAt`, `payee`, `asset` and `model`. Amounts are stored as
`TEXT`, and the ledger sums them as `bigint` in JavaScript rather than in SQL,
so no precision is lost. Indexes on `issuedAt`, `payee` and `asset` support
the filters, and a `schema_version` table lets a future release refuse a file
it cannot read instead of guessing.

Every receipt read back from SQLite is parsed with `signedReceiptSchema`. A
row that was edited or truncated throws a `TollwayError` whose code is
`corrupt-receipt`, so a damaged database surfaces as an error and never as a
malformed receipt.

The store holds the signed receipt and nothing else. It never stores keys, and
the receipt is already the only signature it needs.

## The durability guarantee

Tollway keeps two rules about the gap between a settled payment and its
receipt:

1. **A store write failure never loses a receipt.** The payment has already
   settled by the time the store is written, so `pay()` still resolves with the
   verified receipt, sets `storeError` on the result, and calls
   `onStoreError(error, receipt)` when you provide one. This mirrors the gate's
   `onCacheError`: alert on it, and expect the store's history to have a hole
   for that payment.
2. **A receipt is stored before `pay()` resolves.** The write is awaited, and
   a receipt that fails verification is never written.

Neither rule makes the store transactional with the chain. A process that
crashes between settlement and the store write loses that write; `storeError`
covers a failed write, not a process that never got the chance to make one.
