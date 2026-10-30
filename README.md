<p align="center">
  <img src="assets/brand/tollway-logo.png" alt="Tollway logo" width="140" />
</p>

<h1 align="center">Tollway</h1>

<p align="center">
  Orchestration, policy, and observability for agent payments on Stellar.
</p>

<p align="center">
  <a href="https://usetollway.vercel.app"><strong>Website</strong></a> ·
  <a href="https://usetollway.vercel.app/docs"><strong>Docs</strong></a>
</p>

<p align="center">
  <a href="https://github.com/vegaforge/tollway/actions/workflows/ci.yml"><img src="https://github.com/vegaforge/tollway/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache-2.0" /></a>
</p>

---

## Why Tollway exists

Stellar ships two agent-payment primitives, and they are different tools with different settlement models and separate SDKs.

**x402** settles one payment per request. A client hits a route, gets a `402` carrying a `PAYMENT-REQUIRED` challenge, signs a Soroban authorization entry, resubmits it in a `PAYMENT-SIGNATURE` header, and a facilitator verifies and settles on chain before the server returns the resource. Funds go straight to the recipient; the facilitator is non-custodial.

**MPP** covers the other cost shapes. Its *charge* mode is per-request and on-chain, much like x402. Its *channel* mode is a different settlement model entirely: a one-way payment channel in a Soroban contract where the funder deposits once, then makes many off-chain payments by signing cumulative commitments, and a single on-chain transaction at close pays the recipient the cumulative total and returns the remainder.

Both primitives are good. The cost shows up the moment a service or an agent uses more than one of them. Someone has to choose the model per counterparty, run the channel lifecycle, enforce budgets across models, normalize three different settlement artifacts into one receipt, reconcile off-chain commitments against on-chain settlement, and provide observability over all of it. Every team rebuilds that layer, and it is real systems work.

Tollway is that layer, built once and shared. It sits **above** `@x402/stellar` and `@stellar/mpp` and composes them. It is not a facilitator, not a base SDK, and it never custodies funds.

## Architecture

Tollway is a library plus an optional shared service. Most users embed the library: a client wrapper on the agent side, payment-gate middleware on the service side. Teams that want shared budgets, reconciliation, and dashboards across many processes run the optional service.

```mermaid
flowchart TB
  subgraph agent["Agent side"]
    AC[Agent code]
    CL["@tollway/client"]
    AC --> CL
  end

  subgraph svc["Service side"]
    RT[HTTP route]
    MW["@tollway/server gate"]
    AD["framework adapter (express, fastify, next, hono)"]
    RT --> AD --> MW
  end

  subgraph core["@tollway/core"]
    POL[Policy and budget engine]
    ROUTER[Model router]
    RCPT[Canonical signed receipt]
  end

  subgraph shared["Shared services (optional)"]
    CHAN["@tollway/channels lifecycle"]
    RECON["@tollway/reconcile"]
    OBS["@tollway/observability"]
  end

  subgraph base["Stellar base layer"]
    FAC["facilitator /verify /settle"]
    X402["@x402/stellar"]
    MPP["@stellar/mpp channel contract"]
  end

  CL --> POL --> ROUTER
  MW --> POL
  ROUTER -->|x402 / mpp-charge| FAC
  ROUTER -->|mpp-channel| CHAN
  FAC --> X402
  CHAN --> MPP
  ROUTER --> RCPT
  RECON -.checks.- CHAN
  RECON -.checks.- FAC
  OBS -.reads.- RCPT
```

### The model router

The router is the conceptual core. Per interaction or per counterparty it decides how a payment settles:

- **x402 per-request** is the default for unknown counterparties and the right answer when access is occasional and per-URL accountability matters.
- **MPP charge** applies when the service standardizes on MPP but traffic is still per-request.
- **MPP channel** kicks in when sustained high-frequency access to a single counterparty crosses a configurable threshold. The router opens a channel, routes later payments as off-chain commitments, and schedules the close.

Its inputs are declared offer hints, observed traffic shape, explicit configuration, and policy constraints. Every decision is overridable per route and per agent.

### The x402 request path

The x402 path runs end to end through `@tollway/core`, `@tollway/server`, an adapter, and a facilitator. The header encoding and payload shapes do not yet match the x402 V2 wire format that stock x402 clients send; that work is tracked in [#43](https://github.com/vegaforge/tollway/issues/43).

```mermaid
sequenceDiagram
  participant Agent
  participant Gate as Tollway gate (service)
  participant Fac as Facilitator

  Agent->>Gate: GET /resource
  Gate-->>Agent: 402 + PAYMENT-REQUIRED (offer)
  Agent->>Agent: sign Soroban authorization entry
  Agent->>Gate: GET /resource + PAYMENT-SIGNATURE
  Gate->>Fac: POST /verify
  Fac-->>Gate: valid, payer, nonce
  Note over Gate: idempotency cache keyed by nonce
  Gate->>Fac: POST /settle
  Fac-->>Gate: transaction hash
  Gate->>Gate: build + sign canonical receipt
  Gate-->>Agent: 200 + resource + PAYMENT-RESPONSE (receipt)
```

A short-lived settlement cache keyed by the authorization nonce makes a duplicate submission idempotent rather than a second charge. In channel mode the cumulative-commitment design is naturally idempotent, since a repeated commitment at the same sequence is a no-op.

### The canonical receipt

Every settlement, on any model, produces one signed receipt. Downstream accounting, dispute evidence, and analytics consume a single shape instead of three.

| Field | Meaning |
| ----- | ------- |
| `payer`, `payee` | Stellar addresses on each side |
| `amount`, `asset` | integer string in the asset's smallest unit |
| `resource` | URL or stable identifier of what was bought |
| `model` | `x402`, `mpp-charge`, or `mpp-channel` |
| `settlement` | transaction hash (x402, charge) or channel id + commitment sequence (channel) |
| `network`, `issuedAt` | testnet or mainnet, and an ISO 8601 timestamp |
| `signature` | Ed25519 over the canonical bytes, with the signing `keyId` |

Receipts are signed through a swappable signer interface, so the key can live in process, in a KMS, or behind an HSM. Canonicalization sorts object keys at every level, so the same receipt body always produces the same bytes and the same signature.

## Packages

Tollway is a pnpm and Turborepo monorepo. Each package is independently buildable, so you can work on one without building the rest.

| Package | Responsibility |
| ------- | -------------- |
| `@tollway/core` | model router, policy schema, canonical receipt, shared types |
| `@tollway/client` | agent-side client wrapper |
| `@tollway/server` | service-side payment gate, framework agnostic |
| `@tollway/adapter-express` | Express adapter (the reference adapter) |
| `@tollway/adapter-fastify` | Fastify adapter |
| `@tollway/adapter-next` | Next.js App Router adapter |
| `@tollway/adapter-hono` | Hono adapter |
| `@tollway/channels` | MPP channel lifecycle manager |
| `@tollway/reconcile` | reconciliation engine |
| `@tollway/observability` | metrics, exports, webhooks |
| `@tollway/theme` | shared design tokens |

Apps: `apps/web` (landing page and docs), `apps/dashboard` (observability UI), `apps/demo` (end-to-end x402 demo).

## Quickstart

Requires Node 22+ and pnpm 10+.

```bash
git clone https://github.com/vegaforge/tollway.git
cd tollway
pnpm install
pnpm build
pnpm test
```

Run the x402 demo with no network, from challenge to a verified receipt:

```bash
MOCK_MODE=true pnpm --filter @tollway/demo start
```

Without `MOCK_MODE`, the demo pays 0.001 testnet USDC through the OpenZeppelin Channels testnet facilitator and prints the settlement transaction hash. It needs two testnet accounts with a USDC trustline (the payer also needs testnet USDC from the [Circle faucet](https://faucet.circle.com/)) and an API key from [channels.openzeppelin.com/testnet/gen](https://channels.openzeppelin.com/testnet/gen). Use testnet keys only: the payer's secret key sits in an environment variable.

```bash
OZ_API_KEY=... \
STELLAR_RECIPIENT=G... \
STELLAR_SECRET_KEY=S... \
pnpm --filter @tollway/demo start
```

If a setting is missing or invalid, the demo lists every problem and exits with code 1. `FACILITATOR_URL` overrides the facilitator. `STELLAR_NETWORK=mainnet` switches to mainnet and then also needs `STELLAR_RPC_URL`.

Gate a route on the service side:

```ts
import { Ed25519Signer } from "@tollway/core";
import { createPaywall, createMockFacilitator } from "@tollway/server";
import { expressPaywall } from "@tollway/adapter-express";

const signer = await Ed25519Signer.generate("service-key");
const gate = createPaywall(
  { amount: "10000", asset: "USDC:GA5Z...", payTo: "GSERVICE...", network: "testnet" },
  { signer, facilitator: createMockFacilitator() },
);

app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
  res.json({ symbol: "XLM/USD", price: "0.1234" });
});
```

## Status

Tollway is pre-release. No package is published to npm yet; build from this repository.

Implemented and tested:

| Package or app | What works |
| -------------- | ---------- |
| `@tollway/core` | Canonical receipt (build, sign, verify) with a swappable Ed25519 signer, zod schemas, the policy engine (`createPolicyEngine`: budgets, per-service caps, rate limits, and anomaly stops, held in memory), and the default model router. |
| `@tollway/server` | The payment gate (`createPaywall`) for x402 and MPP charge, an HTTP facilitator client built on `@x402/core` and `@x402/stellar`, a mock facilitator, a mock MPP charge handler, and in-memory and Redis settlement caches. |
| `@tollway/adapter-express`, `-fastify`, `-next`, `-hono` | All four adapters wrap the gate, each with its own tests. |
| `@tollway/client` | Agent-side orchestration: policy check, routing, receipt verification, and events. You supply the `ClientSettler` that signs payments. |
| `@tollway/channels` | Channel `open`, `commit`, `shouldClose`, and `close` against an injected `MppChannelAdapter`. |
| `@tollway/reconcile` | The reconciler and drift detection, with unit and property tests. |
| `@tollway/observability` | Metric recording, spend summaries, JSON and CSV export, and webhook delivery with retry and timeout. |
| `@tollway/theme` | Shared design tokens. |
| `apps/dashboard` | Agents, channels, and receipts views over typed hooks backed by stub data. |
| `apps/demo` | The x402 round trip in mock mode. |

Open work:

- Real MPP charge settlement with `@stellar/mpp`: `createMppChargeHandler` throws `NotImplementedError` today ([#100](https://github.com/vegaforge/tollway/issues/100)).
- A real `MppChannelAdapter` backed by `@stellar/mpp/channel` ([#101](https://github.com/vegaforge/tollway/issues/101)).
- `ChannelManager.recover`, which throws `NotImplementedError` today ([#38](https://github.com/vegaforge/tollway/issues/38)).
- Router promotion to `mpp-channel` under sustained traffic ([#105](https://github.com/vegaforge/tollway/issues/105)). The gate answers `501` if a router selects `mpp-channel`.
- x402 V2 wire compatibility for the gate's headers ([#43](https://github.com/vegaforge/tollway/issues/43)).
- A production x402 `ClientSettler` for `@tollway/client` ([#102](https://github.com/vegaforge/tollway/issues/102)).
- Feeding gate outcomes into `@tollway/observability` ([#106](https://github.com/vegaforge/tollway/issues/106)) and signing webhook deliveries ([#104](https://github.com/vegaforge/tollway/issues/104)).
- A shared conformance suite for the four adapters ([#107](https://github.com/vegaforge/tollway/issues/107)).
- Dashboard services and exports views ([#108](https://github.com/vegaforge/tollway/issues/108), [#109](https://github.com/vegaforge/tollway/issues/109)). The overview and anomalies pages are placeholders.

Browse the [open issues](https://github.com/vegaforge/tollway/issues) for claimable work, especially the [good first issues](https://github.com/vegaforge/tollway/issues?q=is%3Aissue+is%3Aopen+label%3Adifficulty%3Agood-first-issue). The full design and the planned sequence of work are in [docs/design.md](docs/design.md).

## Security

Non-custodial throughout: x402 settles to the recipient, channel funds live in the channel contract, and Tollway never holds funds. Replay protection comes from the settlement cache and the idempotent cumulative-commitment design; reconciliation is the safety net against a counterparty that under-settles. Report vulnerabilities through [SECURITY.md](SECURITY.md), not public issues.

## Contributing

The monorepo is structured so you can own one package without learning the whole system. The framework adapters and the docs are the friendliest starting points; look for the `difficulty:good-first-issue` label. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
