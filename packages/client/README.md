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

## The receipt must describe the payment

A valid signature proves only that the service signed something. Before
`pay()` stores the receipt, records it on the policy engine or emits a
`payment` event, it checks that the receipt describes the payment the agent
made:

- `amount`, `asset`, `payee` (the offer's `payTo`), `resource`, `network` and
  `model` must equal the paid offer exactly;
- the settlement reference must fit the model: a transaction for `x402` and
  `mpp-charge`, a channel commitment for `mpp-channel`;
- when the settler reports the address it paid from (`ClientSettler.payer`,
  which the x402 settler sets), `receipt.payer` must equal it;
- `issuedAt` must be within `receiptMaxSkewMs` of the client clock, five
  minutes by default, so a receipt replayed from an older payment is refused.

A mismatch rejects with `ReceiptOfferMismatchError` (code
`receipt-offer-mismatch`), whose `field` names the first field that differs.
The `error` event fires instead of `payment`, and nothing is recorded or
stored. The message names the field and the two values, never the receipt or
its signature.

Two checks run before anything is paid. An offer for another network than
the client's is refused with `OfferNetworkMismatchError` (code
`offer-network-mismatch`). And the offer's resource must be the one the agent
requested: both are compared by path and query, so a request for
`https://api.example/quotes/latest` matches an offer for `/quotes/latest`,
which is what a gate behind the Express adapter states. The query string is
part of the resource.

These checks run with or without a `verifier`. Without one, the receipt is
still unauthenticated: the checks catch a service that returns the wrong
receipt by mistake, but anyone who can answer the request can forge one that
passes them. Configure a verifier in production.


## Settlers

Two settlers ship with the package, one per per-request model:

- `createX402Settler({ signer, network })` pays x402 V2 routes with `@x402/stellar`.
- `createMppChargeSettler({ secretKey | keypair, network, mode? })` pays MPP charge routes with `@stellar/mpp`. It refuses a challenge unless the amount, recipient, token contract and network match the approved offer, and nothing is signed until they do. In `pull` mode (the default) the service submits the transaction and pays the fee; in `push` mode the agent submits it, so its account also needs XLM. It never patches `globalThis.fetch`.

Both read the Tollway receipt from the `TOLLWAY-RECEIPT` header.
## Hardening an agent

A 402 challenge is attacker-controlled input. Before the policy engine and
before any signature, `pay()` checks the offer itself (#209). A failed check
throws `OfferRejectedError`, a `TollwayError` with code `offer-rejected` whose
`checkName` names the check, and emits a `skip` event. The settler is never
called.

These checks always run:

- **network**: the offer must name the client's `network`. A mismatch is
  refused by the receipt binding above with `OfferNetworkMismatchError`.
- **resource**: the offer must be for the URL the agent requested, under the
  same path-and-query rule.
- **structural**: `amount` is an integer string in base units and is not zero,
  `models` is not empty, and `payTo` and `asset` are not empty.

Configure the rest with `offerChecks`:

```ts
const client = createClient({
  network: "mainnet",
  settler,
  offerChecks: {
    // A ceiling per asset, in base units. USDC on Stellar has 7 decimals,
    // so this is 5 USDC. An asset with no entry is refused: once you set
    // ceilings, every accepted asset needs one.
    maxAmount: { [USDC_CONTRACT]: "50000000" },
    // Exact-string allowlists. No patterns.
    allowedPayees: ["GSERVICE..."],
    allowedAssets: [USDC_CONTRACT],
  },
});
```

| Option | Effect |
| --- | --- |
| `maxAmount` | Refuses an offer above the ceiling for its asset, and any asset with no entry (fail closed). Compared as `bigint`. |
| `allowedPayees` | Refuses a `payTo` outside the list. |
| `allowedAssets` | Refuses an `asset` outside the list. |
| `allowZeroAmount` | Accepts offers for zero. Off by default: a free offer that still asks for a signature is more likely a probe than a sale. |
| `requireNetwork` | The network offers must name. Defaults to `network` and must equal it. |

`createClient` validates `offerChecks` when it is created, so a ceiling that
is not an integer string fails at startup, not on the first payment.

Pass the same `offerChecks` to `createX402Settler` too. It registers the
allowlists as an x402 `PaymentPolicy` over every option in the challenge, so a
402 that lists a disallowed option first cannot steer the settler to it.

Recommended defaults for an agent with real funds: a `maxAmount` entry for
each asset it should spend, an `allowedPayees` list of the services it calls,
and the same checks on the settler.

## Retries

A payment can fail in ways that are safe to try again and ways that are not.
The settler classifies each failure, and `pay()` acts on the class:

| What happened | What `pay()` does |
| --- | --- |
| The service challenged the signed payment again (an expired authorization or a used nonce). Nothing settled. | Checks the policy again, then signs a fresh authorization for the same terms. A challenge asking for a different amount, asset or payee stops the retry. |
| The service is already settling this payment (409 with `Retry-After`). | Waits `Retry-After`, up to 30 seconds, and resends the identical payment. It never signs a new one, so the service answers with the original receipt. |
| The payment may have landed (a 5xx after the signed request, a dropped connection, or a 409 without `Retry-After`). | Never retries. Rejects with `AmbiguousSettlementError` (code `outcome-unknown`). |
| Anything else. | Rejects at once. |

Two consequences are deliberate. A 429 from the service's own rate limit is
"anything else": `pay()` rejects at once and leaves waiting to the caller. A
5xx the service returns before settling, such as a failure to price the
request, still reads as ambiguous, because the client cannot tell it from a
failure after settling. Both err toward never paying twice.

Signing again after an ambiguous outcome is how a payer gets charged twice:
the first transaction may already be on chain, and only the answer was lost.
Reconcile against the chain or the receipt store before paying again.

```ts
import { AmbiguousSettlementError, createClient } from "@vegaforge/tollway-client";

const client = createClient({
  network: "testnet",
  settler,
  policy,
  retry: { maxAttempts: 3 }, // default 2, clamped to 1..5; 1 turns retries off
});

client.on((event) => {
  if (event.type === "retry") console.info(`retry ${event.attempt}: ${event.reason}`);
});

try {
  await client.pay({ resource: "/quotes/latest", offer });
} catch (error) {
  if (error instanceof AmbiguousSettlementError) {
    // Do not pay again. Find out whether the first payment landed.
  }
}
```

Retries are on by default (`maxAttempts: 2`). `maxAttempts` counts every
settler call, resends included. Each fresh authorization is a new payment
attempt for the policy: it is checked again, and it counts toward a rate
limit with `count: "attempts"`. The policy records spend once, after the
payment settles, however many attempts it took.

## Falling back when a channel cannot open

`docs/design.md` promises that a failed channel open falls back to per-request
payment. Pass `fallback` to turn that on:

```ts
const client = createClient({
  network: "testnet",
  settler: channelSettler,
  fallback: {
    x402: createX402Settler({ signer, network: "testnet" }),
    cooldownMs: 60_000, // first rest after a failed open; doubles, up to maxCooldownMs
    maxCooldownMs: 15 * 60_000,
    onOrphanedChannel: ({ counterparty, channelId, txHash }) =>
      alert("channel open may have landed", { counterparty, channelId, txHash }),
  },
});
```

The fallback is taken for one error only: code `channel-open-failed`
(`ChannelOpenFailedError` in `@vegaforge/tollway-core`), which a channel
settler throws when the open failed before any voucher was signed. Then:

- If the offer accepts `x402`, the client asks the policy again for the x402
  payment, emits `fallback`, and pays once by x402. A policy block on x402
  rejects with `PolicyBlockedError`. The spend is recorded once, for x402, and
  the `payment` event and the result name `x402`.
- The counterparty's channel path rests. Until the cooldown ends, its payments
  go straight to x402; then one request at a time tries the channel again.
- An open that may have landed (`submission: "ambiguous"`) is reported to
  `onOrphanedChannel`, so the funder side can resume or recover the channel.

Any other failure on the channel path, including one after a voucher was
sent, a receipt that fails verification and a policy block, is never retried
on x402: the service may already have been paid. Without `fallback`, a failed
open rejects like any other settler error.

## Channel events from a settler

The client never opens channels itself. A channel settler reports its
channels' lifecycle on the client's `on()` stream through
`ClientSettler.subscribe`, which `createClient` calls once:

```ts
const settler: ClientSettler = {
  settle: (request) => payByVoucher(request),
  subscribe(emit) {
    forwardChannelEvents = (event) => {
      if (event.type === "channel:opened" || event.type === "channel:closed") {
        emit({ type: event.type, channelId: event.channelId });
      }
    };
  },
};
```

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
