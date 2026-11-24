# Several payment options on one route

A route can accept more than one way to pay (#158): USDC on mainnet and on
testnet, or two different assets. The 402 lists every option in the service's
order of preference, and the payer settles with the one it picks.

```ts
const gate = createPaywall(
  {
    accepts: [
      { amount: "10000", asset: USDC_MAINNET, payTo, network: "mainnet", facilitator: mainnetFacilitator },
      { amount: "10000", asset: USDC_TESTNET, payTo, network: "testnet", facilitator: testnetFacilitator },
    ],
  },
  { signer, cache },
);
```

The single-option fields (`amount`, `asset`, `payTo`, `network`,
`facilitatorUrl`, `maxTimeoutSeconds`, `extra`) still work and are normalised to
a one-item list. A single-option route's 402 is byte-for-byte what it was before
#158. A config sets either the single-option fields or `accepts`, never both.

## How the payer's choice is matched

The payer names its choice in `PaymentPayload.accepted`, which it controls, so
the gate takes nothing from it. It compares `accepted` with the requirements it
advertises itself, field by field: `scheme`, `network`, `asset`, `payTo`,
`amount` and `maxTimeoutSeconds`. `extra` is not compared: it carries
client-only and scheme data, and a dynamic-price quote inside it is checked on
its own.

- An exact match selects that option. From then on everything uses the
  option's own terms: the router and service policy see its offer,
  pre-validation (#159) checks the envelope against it, its facilitator
  verifies and settles, and the receipt and cache binding carry its amount,
  asset, payee and network.
- No match (a smaller amount, another payee, a network the route does not
  offer) is a 402 `payment-invalid` with a fresh `PAYMENT-REQUIRED` listing
  every option. Nothing is verified or settled.

Single-option routes go through the same match. A payment whose `accepted`
differs from the route's terms is now refused before `/verify` instead of being
sent to the facilitator.

## Replays across options

A payment's cache and archive key is derived from the signed payment alone, and
a stored receipt is only returned for the offer it was issued against. A payment
settled for option 1 that comes back claiming option 2 (or another route, price
or method) is a 409 `offer-mismatch`, never a second settlement and never a
replay.

## Facilitators

Each option settles through its own `facilitator`, or through
`PaywallDeps.facilitator` when it names none. Options on different networks
usually need different facilitators. An option left with neither is a
configuration error at `createPaywall`, as are an empty list, an amount that is
not an integer string, and two options with the same terms.

Run the startup capability check per option: `paymentTargets(config)` returns
one `validatePaywall` target per option, in order.

## Policy

`ModelRouter.decide` receives the chosen option's offer, and so does the service
policy (#160), which runs after `/verify` with the payer known. A spend or
allow-list rule can therefore restrict options per payer; spend windows are kept
per asset.

## Limits

- Dynamic pricing (#157) applies to single-option routes. A route with
  `accepts` has fixed amounts per option.
- MPP charge settles one amount of one asset, so it is offered on the first
  option only.
- Receipts are unchanged: a receipt names the option that was paid through its
  existing `amount`, `asset`, `payee` and `network` fields, so
  docs/receipt-format.md needs no change.
- `routes.list()` reports the first option in the top-level fields and every
  option in `accepts`.

The mock demo runs a two-option route:
`MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start payment-options`.
