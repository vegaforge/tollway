# @vegaforge/tollway-client

Agent-side client that routes, pays, and collects canonical signed receipts across settlement models (x402, MPP charge, MPP channel).

## Install

```bash
pnpm add @vegaforge/tollway-client
```

## Quick start

```ts
import { createClient, createX402Settler } from "@vegaforge/tollway-client";
import { createEd25519Signer } from "@x402/stellar";

const client = createClient({
  network: "testnet",
  settler: createX402Settler({
    signer: createEd25519Signer(process.env.AGENT_SECRET!, "stellar:testnet"),
    network: "testnet",
  }),
});

const { receipt, model } = await client.pay({
  resource: "https://api.example.com/quotes/latest",
  offer,                 // from the 402 challenge header
});
```

## Hardening an agent

A 402 challenge is attacker-controlled input. The `offerChecks` option adds per-offer sanity checks that run **before** the policy engine and **before** any signature is produced. A failing check throws `OfferRejectedError` (a `TollwayError` with code `"offer-rejected"`) and emits a `skip` event; the settler is never called.

### Checks always applied

These run regardless of `offerChecks`:

| Check | What it validates |
|-------|-------------------|
| **network** | `offer.network` must equal the client's `network`. An offer for `mainnet` is always rejected by a testnet client, and vice versa. |
| **structural** | `amount` is a non-negative integer string and is not zero; `models` is non-empty; `payTo` and `asset` are non-empty; `offer.resource` matches the request URL. |

### Configurable checks

```ts
const client = createClient({
  network: "mainnet",
  settler: ...,
  offerChecks: {
    // Per-asset price ceilings (integer strings).
    // FAIL-CLOSED: an asset not in this map is rejected.
    maxAmount: {
      "CBIELTK6YBZ...USDC": "1000000000",   // 100 USDC (7 decimals)
    },

    // Exact-string allowlist of payee addresses.
    allowedPayees: [
      "GCPAYEE...",
    ],

    // Exact-string allowlist of asset identifiers.
    allowedAssets: [
      "CBIELTK6YBZ...USDC",
    ],
  },
});
```

| Check | What it validates |
|-------|-------------------|
| **maxAmount** | `offer.amount` ≤ the ceiling for `offer.asset`. **Fail-closed**: if `maxAmount` is configured and the offer's asset has no entry in the map, the offer is rejected. This is intentional — an operator who sets price limits has expressed intent about which assets are acceptable. |
| **allowedPayees** | `offer.payTo` must be in the set. Use exact strings; glob patterns are not supported. |
| **allowedAssets** | `offer.asset` must be in the set. |

### Recommended defaults

For a production agent:

```ts
offerChecks: {
  // Set a per-asset ceiling well above normal prices but below a catastrophic amount.
  maxAmount: { [USDC_CONTRACT]: "10000000000" }, // 1,000 USDC

  // Restrict to known counterparties.
  allowedPayees: KNOWN_SERVICE_ADDRESSES,

  // Allow only the assets the agent intends to spend.
  allowedAssets: [USDC_CONTRACT],
}
```

Do not use `offerChecks` as a substitute for a policy engine: policy enforces spend over time (daily budgets, per-service caps, anomaly stops). These checks enforce per-offer validity. Both should be configured for a hardened agent.

### x402 multi-option challenges

When `offerChecks` includes `allowedPayees` or `allowedAssets`, the x402 settler also registers an `x402Client` `PaymentPolicy` that filters the `accepts` array in the 402 challenge. This prevents a challenge constructed with both allowed and disallowed options from steering the settler to a disallowed one.

## Events

```ts
client.on((event) => {
  switch (event.type) {
    case "payment":    // settled; event.receipt is the canonical signed receipt
    case "skip":       // rejected before settlement; event.reason names the check
    case "error":      // unexpected error
    case "policy:decision":  // policy trace for this payment
    case "budget:warning":   // remaining budget is low
  }
});
```

## API

### `createClient(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `network` | `StellarNetwork` | ✓ | `"testnet"` or `"mainnet"` |
| `settler` | `ClientSettler` | ✓ | Protocol-specific signer/submitter |
| `offerChecks` | `OfferChecks` | | Per-offer sanity checks (see above) |
| `policy` | `PolicyEngine` | | Spend policy; omit to allow all payments |
| `shadow` | `PolicyEngine` | | Candidate policy evaluated alongside the active one |
| `router` | `ModelRouter` | | Model selection; defaults to x402 |
| `verifier` | `ReceiptVerifier` | | Receipt signature verification |
| `facilitatorUrl` | `string` | | Default facilitator URL |
| `logger` | `{ warn }` | | Construction-time warnings; defaults to `console` |

### `createX402Settler(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `signer` | `ClientStellarSigner` | ✓ | From `createEd25519Signer` in `@x402/stellar` |
| `network` | `StellarNetwork` | ✓ | |
| `offerChecks` | `OfferChecks` | | Registers a `PaymentPolicy` on the x402 client |
| `fetch` | `typeof fetch` | | Inject in tests |
| `rpcUrl` | `string` | | Soroban RPC URL |
| `method` | `string` | | HTTP method (default `GET`) |
