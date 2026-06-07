<p align="center">
  <img src="assets/brand/tollway-logo.png" alt="Tollway logo" width="160" />
</p>

# Tollway

Orchestration, policy, and observability for agent payments on Stellar.

[![CI](https://github.com/vegaforge/tollway/actions/workflows/ci.yml/badge.svg)](https://github.com/vegaforge/tollway/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Stellar gives agents two ways to pay for things. x402 charges per request: a 402 challenge, a signed Soroban authorization, an on-chain settlement. MPP adds a charge mode that works the same way, plus a channel mode where an agent deposits once and streams thousands of payments off chain as signed commitments, settled in a single transaction at close.

Both primitives are solid, and both have good SDKs. The trouble starts when you use more than one. Someone has to decide which model fits which traffic, run the channel lifecycle, enforce budgets across all of it, make three different settlement artifacts look like one receipt, and reconcile off-chain commitments against what actually landed on chain. Right now every team wires that up themselves.

Tollway is that wiring, built once and shared. It sits above `@x402/stellar` and `@stellar/mpp`:

- Routes each interaction to the right settlement model (x402 per-request, MPP charge, MPP channel) based on traffic shape, with manual override when you know better
- Runs the full channel lifecycle: open, commit, close, recover
- Enforces spending policies and budgets, on chain through OpenZeppelin smart accounts where possible, at the application layer otherwise
- Emits one canonical signed receipt no matter how the payment settled
- Reconciles channel commitments against on-chain settlement and flags drift
- Shows you spend, latency, and failures per agent, per service, per model

It is not a facilitator, not a payment SDK, and it never holds funds. The reasoning behind all of this lives in the [design document](docs/design.md).

## Architecture

```
AGENT SIDE
  Agent code
    -> Tollway client
         -> policy/budget check
         -> model router (x402 / mpp-charge / mpp-channel)
         -> @x402/stellar  OR  @stellar/mpp
         -> sign Soroban auth entry / channel commitment
         -> normalized receipt store

SERVICE SIDE
  HTTP route
    -> Tollway middleware
         -> read PAYMENT-SIGNATURE / channel commitment
         -> call facilitator /verify + /settle  OR  record channel commitment
         -> emit normalized receipt
         -> deliver resource with PAYMENT-RESPONSE
```

## Packages

| Package | Description |
| ------- | ----------- |
| `@tollway/core` | Model router, policy engine, canonical receipt format, shared types |
| `@tollway/client` | Agent-side client wrapper |
| `@tollway/server` | Service-side middleware, framework agnostic |
| `@tollway/adapter-express` | Express adapter |
| `@tollway/adapter-fastify` | Fastify adapter |
| `@tollway/adapter-next` | Next.js adapter |
| `@tollway/adapter-hono` | Hono adapter |
| `@tollway/channels` | MPP channel lifecycle manager |
| `@tollway/reconcile` | Reconciliation engine |
| `@tollway/observability` | Metrics, exports, webhooks |
| `@tollway/theme` | Shared design tokens |

Plus three apps: `apps/dashboard` (observability UI), `apps/web` (landing page and docs), and `apps/demo` (end-to-end demo).

## Quickstart

You need Node 22+ and pnpm 10+.

```bash
git clone https://github.com/vegaforge/tollway.git
cd tollway
pnpm install
pnpm build
pnpm test
```

Run the demo without touching the network:

```bash
MOCK_MODE=true pnpm --filter @tollway/demo start
```

To run against a real testnet facilitator instead, unset `MOCK_MODE` and set `FACILITATOR_URL` if you want something other than the default (the OpenZeppelin Stellar facilitator).

## Where the project stands

Phase 0: the foundation and a thin x402 per-request slice are in place. MPP charge mode, the channel lifecycle, policy enforcement, reconciliation, and the dashboard are typed stubs with issues attached. The [build plan](docs/design.md#build-plan) lays out the phases, and [SEED_ISSUES.md](SEED_ISSUES.md) maps the open work to packages.

## Contributing

The monorepo is structured so you can own one package without learning the whole system. Adapters and examples are the friendliest entry points; look for the `difficulty:good-first-issue` label. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and conventions.

## License

[Apache-2.0](LICENSE)
