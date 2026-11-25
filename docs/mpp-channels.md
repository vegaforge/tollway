# Receiving MPP channel payments

This page describes the service side of MPP channel mode in
`@vegaforge/tollway-server`: how the gate accepts vouchers on an agent's
one-way channel (#173), and how the service closes the channel to collect
what it earned (#174). The agent side, opening a channel and signing
commitments, is in `@vegaforge/tollway-channels` and on the
[Channels](../apps/web/src/content/docs/channels.mdx) page.

## Terms

- **Channel.** A deployed `stellar-experimental/one-way-channel` Soroban
  contract. The funder (`from`) deposits tokens once; the recipient (`to`) can
  close it with the funder's latest signed commitment.
- **Voucher.** One MPP `stellar/channel` credential: the funder's Ed25519
  signature over the contract's commitment bytes for a cumulative amount
  (what the contract's `prepare_commitment` returns). Amounts are cumulative
  and in base units.
- **Commitment key.** The Ed25519 public key the contract checks voucher
  signatures against. It is fixed at deployment.
- **Sequence.** Tollway's count of accepted vouchers on a channel: 1 for the
  first, then one more per voucher. Receipts are anchored at
  `{ kind: "channel-commitment", channelId, sequence }`.

## Flow

1. The agent sends a request with `TOLLWAY-CHANNEL: C...`, naming its channel.
2. If the service has not seen the channel, it registers it by reading the
   contract on chain. The channel must pay out to the route's `payTo`, in the
   route's `asset`, must not be closing, and must have a refund waiting
   period of at least `minRefundWaitingPeriod` ledgers (default 17280, about a
   day). The commitment key is read from the contract's instance storage,
   never from the request: a key chosen by the client would let signatures
   pass here that the contract's `close` rejects.
3. The gate answers 402 with the `mppx` challenge for that channel in
   `WWW-Authenticate`, next to the x402 `PAYMENT-REQUIRED` header. The
   challenge amount on the wire is the offer amount in base units.
4. The agent answers with `Authorization: Payment ...`. The gate checks that
   this server issued the challenge, that the challenge is for this offer's
   amount and resource, and that the voucher adds exactly the offer amount to
   the last accepted cumulative.
5. `@stellar/mpp` verifies the signature against the commitment key, checks
   the channel on chain again, and advances its own cumulative. Tollway then
   records the voucher and signs the receipt. The receipt's `payer` is the
   channel's on-chain funder.

A request without `TOLLWAY-CHANNEL` gets the ordinary 402 without a channel
challenge, because a channel challenge names one contract.

## Rejection reasons

The gate answers every refusal with a code from
[gate-errors.md](gate-errors.md), and the channel's own reason starts with a
stable channel code followed by a colon:

- A refused registration (the first group below) is `channel-refused` (402),
  with the channel reason as the message.
- A refused voucher is `payment-invalid` (402) with a fresh challenge, and the
  channel reason in `upstreamReason`.
- `channel-state-unavailable` is `facilitator-unavailable` (503), `channel-busy`
  is `settlement-in-progress` (409), and the two rate limits are
  `channel-rate-limited` (429), each with `Retry-After`.

| Channel code | Meaning | What the client does |
| ---- | ------- | -------------------- |
| `channel-invalid` | `TOLLWAY-CHANNEL` is not a contract address | Send a `C...` address |
| `channel-recipient-mismatch` | The channel pays out to someone else | Use a channel to this service |
| `channel-token-mismatch` | The channel pays in another token | Use a channel in the offer's asset |
| `channel-closing` | `close_start` or `close` has run on chain | Open a new channel |
| `channel-refund-period-too-short` | The refund window is below the service minimum | Deploy with a longer window |
| `channel-state-unavailable` | The chain could not be read | Retry later |
| `registration-rate-limited` | Too many registrations | Retry later |
| `channel-not-registered` | A voucher for a channel never challenged | Send `TOLLWAY-CHANNEL` first |
| `channel-offer-mismatch` | The channel was registered for another payee, asset or network | Use the right channel |
| `channel-settling` | The service is closing the channel | Open a new channel |
| `channel-closed` | The channel is closed | Open a new channel |
| `channel-pending-reconciliation` | A voucher is unrecorded after a crash | Retry after the operator reconciles |
| `channel-busy` | The channel changed during this request | Retry |
| `voucher-already-accepted` | This exact voucher was already paid for | Send the next cumulative |
| `commitment-conflict` | Another signature was accepted at this cumulative | Stop; the channel state disagrees |
| `stale-cumulative` | The cumulative is below the accepted one | Send the next cumulative |
| `wrong-increment` | The voucher does not add exactly the price | Sign `previous + price` |
| `close-not-supported` | The service takes no close credentials | Send a voucher |
| `close-rate-limited` | The fee payer's close budget is spent | Retry later |
| `mpp-channel-rejected` | `@stellar/mpp` refused the voucher | Read the message |

## Replays and idempotency

The idempotency key is the SHA-256 of the channel, cumulative amount and
signature, so it comes from the signed voucher itself. A resent voucher is
answered from the settlement cache with the original receipt and
`replayed: true`, without calling `@stellar/mpp` again. Once the cache entry
has expired, the same voucher is rejected with `voucher-already-accepted`
rather than served again for free.

## Stores and processes

Two stores are involved:

- `@stellar/mpp`'s `Store.AtomicStore` (`store`), which keeps the SDK's own
  cumulative and replay records. Its `update()` must be a linearizable
  compare-and-set.
- Tollway's `ChannelStore` (`channels`), which keeps registration facts, the
  latest accepted voucher, and the channel status. Every write is a
  compare-and-set on a version number, and every read is parsed with
  `channelRecordSchema`.

`Store.memory()` and `createInMemoryChannelStore()` are correct in one
process. Several processes need shared backends with real compare-and-set,
such as a Redis Lua script or a PostgreSQL `UPDATE ... WHERE version = $n`.
Tollway does not ship one yet.

Order of writes per voucher: Tollway marks the voucher pending, then
`@stellar/mpp` verifies it, then Tollway records it as accepted and the gate
signs the receipt. Tollway never issues a receipt for a voucher the SDK did
not accept. A crash between the SDK accepting and Tollway recording leaves
the voucher pending and the channel blocked
(`channel-pending-reconciliation`). `handler.reconcile(channelId)` resolves
it by reading the SDK's cumulative: if the SDK holds the pending amount the
voucher is committed, if it holds the previous amount the voucher is
discarded.

## Settlement

`createChannelSettler` closes channels on chain with the latest accepted
voucher, using `close` from `@stellar/mpp/channel/server`. Closing ends the
channel: the contract pays the voucher amount to the recipient and refunds
the rest to the funder.

- `settle(channelId)` moves the channel from `open` to `settling` with a
  compare-and-set before it reads the voucher to close with. From that point
  the gate rejects vouchers with `channel-settling`, so none is accepted and
  then lost, and a second process loses the compare-and-set and sends
  nothing. A channel with no accepted voucher is never closed.
- `evaluate()` closes every open channel whose triggers fire: accepted
  cumulative at or above `minCumulative`; cumulative at or above a fraction of
  the on-chain balance (`cumulative * denominator >= balance * numerator`);
  no voucher for `idleMs`; or registered `maxChannelAgeMs` ago. It has no
  timers, so a cron job or queue worker can call it. `start({ intervalMs })`
  and `stop()` are an optional helper with an unref'd timer.
- The close rate guard caps closes per fee-payer key per window.
  `@stellar/mpp`'s `feeBudget` does not cover the standalone `close`, so the
  guard is required. Share one guard between the settler and the channel
  handler.
- On success the channel is `closed` with a `SettlementRecord`
  (`{ channelId, settledAmount, returnedRemainder, txHash }`), the shape
  `@vegaforge/tollway-reconcile` consumes. `returnedRemainder` is the balance
  read just before the close minus the voucher amount; the balance is read
  again afterwards and `onCloseAnomaly` fires if the channel does not look
  closed and empty. The remainder assumes nothing was withdrawn from the
  channel before the close, which holds when Tollway is the only closer.
- If `close` throws, the channel stays `settling`, because the transaction
  may have reached the chain. `resolve(channelId)` reads the chain: closed
  and empty marks the channel `closed` (without a transaction hash, which
  the operator finds on chain); not closed, or closed by the funder with
  funds still in it, marks the attempt retryable so `settle` can send it
  again. A failed close never returns the channel to accepting vouchers.

An agent can also ask to close with an MPP `close` credential. The handler
accepts it only when it has a `feePayer`; it freezes the channel, lets
`@stellar/mpp` broadcast the close inside its own `verify`, records the same
`SettlementRecord`, and returns a receipt. Set the gate's
`facilitatorTimeoutMs` above `@stellar/mpp`'s poll timeout for routes that
accept close credentials.

Secrets (`secretKey`, fee payer keys) are passed to `mppx` and `@stellar/mpp`
only and never appear in errors or logs.

## Configuration

```ts
import { Store } from "@stellar/mpp/channel/server";
import {
  createChannelSettler,
  createInMemoryChannelStore,
  createInMemoryCloseRateGuard,
  createInMemorySettlementCache,
  createMppChannelHandler,
  createPaywall,
} from "@vegaforge/tollway-server";

const channels = createInMemoryChannelStore();
const closeRateGuard = createInMemoryCloseRateGuard({ maxCloses: 20, windowMs: 3_600_000 });

const gate = createPaywall(
  { amount: "10000", asset: USDC_SAC, payTo: SERVICE_ACCOUNT, network: "testnet", models: ["mpp-channel"] },
  {
    signer,
    facilitator,
    cache: createInMemorySettlementCache(),
    mppChannelHandler: createMppChannelHandler({
      recipient: SERVICE_ACCOUNT,
      currency: USDC_SAC,
      network: "testnet",
      secretKey: process.env.MPP_SECRET_KEY ?? "",
      store: Store.memory(),
      channels,
      closeRateGuard,
    }),
  },
);

const settler = createChannelSettler({
  channels,
  network: "testnet",
  feePayer: { envelopeSigner: process.env.FEE_PAYER_SECRET ?? "" },
  feePayerKey: FEE_PAYER_ACCOUNT,
  closeRateGuard,
  triggers: { minCumulative: "50000000", idleMs: 3_600_000 },
});
settler.start({ intervalMs: 60_000 });
```

## Testing

`packages/server/src/mpp-channel.integration.test.ts` runs the whole flow
against a deployed channel on testnet. It is skipped unless
`TOLLWAY_MPP_CHANNEL_INTEGRATION=true`; the file header lists the variables.
