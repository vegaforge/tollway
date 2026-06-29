# Tollway design document

This document explains why Tollway exists, what it does and deliberately does not do, and how the pieces fit together. It is the reference we point to when a pull request raises a scope question. If something in the code contradicts this document, one of the two is wrong and worth an issue.

The name comes from the road you pay to travel on. Agent traffic pays its way across protocols and settlement models, and Tollway is the road surface.

## The problem

Stellar shipped two agent-payment primitives in early 2026, and they are genuinely different tools with separate SDKs and separate mental models.

x402 handles one payment per request. A client hits a route, gets a 402 with a `PAYMENT-REQUIRED` header, signs a Soroban authorization entry, resubmits with a `PAYMENT-SIGNATURE` header, and the facilitator verifies and settles on chain before the server returns the resource with a `PAYMENT-RESPONSE` header. It ships as `@x402/stellar`, with production facilitators from Coinbase and OpenZeppelin. The OpenZeppelin one runs as a Relayer plugin exposing `/verify`, `/settle`, and `/supported`, live on testnet and mainnet.

MPP handles the other cost shapes. Its charge mode looks like x402: per-request, settled on chain. Its channel mode is a different settlement model entirely. A one-way payment channel lives in a Soroban contract; the funder deposits tokens once, then makes many off-chain payments by signing cumulative commitments. Nothing touches the chain per payment. Closing the channel submits a single transaction that transfers the cumulative committed amount to the recipient and returns the remainder to the funder. MPP ships as `@stellar/mpp` with its own channel contract, deployment scripts, and intents.

Both primitives are good. The problem starts when a service wants to monetize agent traffic, or an agent wants to pay across many services, because nobody has unified the layer above them:

Choosing a model is a real decision with real costs. Per-request x402 suits occasional, accountable access. Channel mode suits an agent hitting one service thousands of times an hour. Charge mode sits between. Choose wrong and you either pay per-request overhead on high-frequency traffic or lose per-request accountability on low-frequency traffic. Nothing picks for you.

Channel lifecycle is real work. Channel mode means opening a channel, tracking cumulative commitments off chain, deciding when to close, handling the close and the remainder, and recovering if the counterparty disappears. The SDK gives you the primitive. It does not run the lifecycle.

Spending policy is scattered. OpenZeppelin's smart-account contracts on Stellar support spending limits, multisig, and programmable policies, and embedded-wallet providers exist, but binding those policies to actual x402 and MPP flows (per-service caps, per-session budgets, anomaly stops) is left to each integrator.

Receipts are not uniform. x402 settlement confirmations, MPP charge settlements, and MPP channel commitments are different artifacts. Use more than one model and your accounting, dispute evidence, and analytics now consume more than one shape.

Reconciliation is rebuilt per team. The whole point of channel mode is that most payments are off-chain commitments, which means someone has to reconcile the commitment stream against the single on-chain settlement, detect drift, and alert. Every team currently writes this themselves.

And there is no shared observability. No dashboard answers "how much did this agent spend across services this hour, on which model, with what failure rate."

None of these are gaps in x402 or MPP. They are the orchestration layer above both. That layer does not exist yet, and it is too much work for each team to build well on their own. That layer is Tollway's entire scope.

## What Tollway is not

Drawing the boundary early keeps the project honest, so here it is.

Tollway is not a facilitator. It calls existing facilitators through `/verify`, `/settle`, and `/supported`. It does not replace them.

Tollway is not a base payment SDK. It composes `@x402/stellar` and `@stellar/mpp`.

Tollway does not custody funds, ever. x402 settles directly to the `PAY_TO` address. MPP channel funds live in the channel contract. Tollway orchestrates; it does not hold.

Tollway does not implement a wallet or a smart-account contract. It integrates OpenZeppelin smart accounts and standard wallets.

Tollway does not do agent identity or reputation. That is a separate concern and a separate project.

The base layer is saturated and good: SDKs, facilitators, framework adapters, smart-account policy contracts, fee sponsorship. Rebuilding any of it would be wasted effort. Everything Tollway does composes those primitives from one layer up.

## Who it is for

Service operators monetizing APIs, data feeds, inference endpoints, or content for agent consumption, who want to accept payment without wiring two protocols themselves.

Agent developers whose agents call many paid services and who need budget enforcement, channel management, and a single spend ledger across providers.

Platform integrators (gateways, marketplaces, AI infrastructure) embedding agent payments into a product and wanting one dependency instead of several.

If you need a single x402 route on a single service, you do not need Tollway. Use `@x402/stellar` directly. Tollway earns its keep once more than one model or more than a handful of services is in play.

## Architecture

Tollway is a library plus an optional service. Most users embed the library: server middleware for services, a client wrapper for agents. Teams that want shared budgets, reconciliation, and dashboards across many processes run the optional service.

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
    -> Tollway middleware (the gating "molecule")
         -> read PAYMENT-SIGNATURE / channel commitment
         -> call facilitator /verify + /settle  OR  record channel commitment
         -> emit normalized receipt
         -> deliver resource with PAYMENT-RESPONSE

SHARED OPTIONAL SERVICE
  - Channel lifecycle manager (open/commit/close/recover)
  - Reconciliation engine (commitments vs on-chain settlement)
  - Policy store (budgets, caps, anomaly rules)
  - Observability (dashboard + exports + webhooks)
  - Receipt archive
```

### The model router

The router is the conceptual core of the project. Per interaction or per counterparty, it decides which settlement model to use.

x402 per-request is the default for unknown counterparties, and the right answer when access is occasional and per-URL accountability matters. MPP charge mode applies when the service standardizes on MPP but traffic is still per-request. MPP channel mode kicks in when sustained high-frequency access to a single counterparty crosses a configurable threshold, measured as requests per minute over a window. At that point the router opens a channel, routes subsequent payments as off-chain commitments, and schedules the close.

The router reads four kinds of input: declared hints in the offer (such as `mppSessionSupported` and model preferences), observed traffic shape from a rolling counter per counterparty, explicit configuration, and policy constraints. A budget might only permit channel mode above a minimum deposit, for example. Routing is overridable per route and per agent, because a heuristic that cannot be overridden is a bug waiting for a workaround.

### The channel lifecycle manager

For channel mode, the manager runs the full lifecycle the raw SDK leaves to the integrator.

Open: deposit into the one-way channel contract, sized from the agent's budget and predicted demand. Commit: for each paid interaction, produce and store the next cumulative commitment, advancing the off-chain counter with no on-chain transaction. Close: decide timing from heuristics (budget nearly drawn down, idle timeout, end of session) and submit the single settlement, returning the remainder to the funder. Recover: if a counterparty stops responding mid-channel, follow the contract's dispute or timeout path to get committed funds back, and surface the event loudly.

Recovery is a first-class feature here, not an afterthought. The edge cases live in that path, and so do the tests.

### Policy and budgets

Policy is data, not code: a small declarative schema covering per-agent daily and total budgets, per-service caps, per-model constraints, rate limits, and anomaly stops for sudden spend spikes. Enforcement applies across all three models.

Where the agent uses an OpenZeppelin smart account, Tollway maps as many constraints as possible down to the on-chain smart-account policy, so the chain itself backs the limit. Where it does not, Tollway enforces at the application layer. Defense in depth, with the honest caveat that application-layer enforcement is only as strong as the process running it.

### One receipt format

Every settlement, regardless of model, produces one canonical signed receipt: the counterparties, amount, asset, URL or resource id, the model used, a settlement reference, a timestamp, and a Tollway signature. The settlement reference is a Stellar transaction hash for x402 and MPP charge, and a channel id plus commitment sequence for channel mode. Downstream accounting, dispute evidence, and analytics consume one shape instead of three.

### Reconciliation

For channel mode, the engine continuously compares the stored stream of cumulative commitments against the channel contract state, and at close against the on-chain settlement. It detects drift, such as a commitment not reflected on close or an unexpected remainder, flags it, and can block further commitments to a counterparty that is behaving inconsistently. For x402 and MPP charge, reconciliation is simpler: confirm each `/settle` landed on chain and matches the receipt.

This engine is the safety net that catches a counterparty who under-settles relative to what was committed. It has to be trustworthy, which is why it gets property tests against random commitment streams rather than a handful of examples.

### Observability

A dashboard and an exporter. Per-agent and per-service spend over time, model mix, latency per model, failure and retry rates, open channels and their remaining budget, and anomaly events. Machine-readable exports in JSON and CSV, and webhooks (`receipt.created`, `channel.opened`, `channel.closed`, `budget.warning`, `anomaly.detected`) for whatever you want to wire up.

For how the dashboard views actually consume this data, including the three UI primitives every widget composes from and the data-layer seam each wired view holds with its source, see `docs/dashboard-data-contracts.md`.

## Design notes

A few decisions worth recording, since each one came up early and will come up again.

The gating molecule. On the service side, Tollway is the small block between request and response. The middleware checks for a valid payment or commitment; if present and valid, it proceeds; if not, it returns a 402 with the right challenge for the chosen model. Switching a route from x402 to MPP charge to MPP channel is a configuration change in this block, not a rewrite. That property is the point, and we preserve it.

Duplicate protection. Facilitators are known to be vulnerable to duplicate `/settle` submissions, so Tollway keeps a short-lived settlement cache keyed by the authorization nonce or commitment sequence, evicted after a window tuned to Stellar's ledger close time. A duplicate is treated as idempotent, not as a second charge. Channel mode is naturally idempotent because a repeated commitment at the same sequence is a no-op, and Tollway enforces that.

Fee sponsorship. We assume sponsorship via the OpenZeppelin relayer path so agents never need to hold XLM, and we surface the sponsoring account's balance as an operational metric. Tollway configures and observes sponsorship; it does not implement it.

Failure semantics. Every model has explicit failure handling. x402 retries with a fresh auth entry on expiry or nonce reuse. Channel open failure falls back to per-request. Budget exhaustion halts with a typed error rather than a silent skip. The client emits events (`payment`, `skip`, `error`, `budget:warning`, `channel:opened`, `channel:closed`) so none of this is invisible.

## Stack

TypeScript, strict mode, everywhere. Not a reflex: the entire base layer is TypeScript-first (`@x402/stellar`, `@stellar/mpp`, and the official framework adapters), so an orchestration layer in TypeScript calls all of it natively. The service-side surface is HTTP middleware for Express, Fastify, Next, and Hono, which is where this ecosystem already lives. And TypeScript keeps the contributor pool wide, since most x402 and MPP integrators are already writing it.

Go is reserved for an optional reconciliation worker if throughput ever demands it; reconciliation is long-running and concurrency-heavy, which suits Go well. That is deferred, and v0 reconciliation runs in TypeScript.

Rust enters only if a future version ships a custom on-chain policy contract. v1 does not. It uses the existing MPP one-way-channel contract and OpenZeppelin smart accounts, so no Soroban contract authoring is required. Keeping Rust out of v1 is deliberate; it keeps the contributor surface broad.

## Repository layout

A pnpm monorepo, structured so a contributor can pick up one package without building the world:

```
tollway/
  packages/
    core/                 # model router, policy engine, receipt format, types (pure TS)
    client/               # agent-side client wrapper
    server/               # service-side middleware (framework-agnostic core)
    adapter-express/      # thin framework adapters
    adapter-fastify/
    adapter-next/
    adapter-hono/
    channels/             # MPP channel lifecycle manager
    reconcile/            # reconciliation engine (TS; Go variant later)
    observability/        # metrics, exports, webhooks
    theme/                # shared design tokens
  apps/
    dashboard/            # Next.js observability UI
    demo/                 # end-to-end demo
    web/                  # landing page and docs
  docs/                   # this document and friends
  examples/               # recipe apps (data feed, inference endpoint, content paywall)
```

The structure doubles as the contributor map. Each adapter, each example, the dashboard widgets, and the eventual reconciliation Go port are independent, well-scoped pieces someone can own without deep context.

## Build plan

The plan is phased so each phase exits with something demonstrably working.

Phase 0, foundation. Monorepo, CI, core types and the receipt format, the model-router interface, and x402 per-request implemented end to end against a testnet facilitator. Exit: one paid request settles and produces a canonical receipt.

Phase 1, MPP charge. Add charge mode behind the same router and receipt format. Exit: the same route serves both x402 and MPP charge with a config flag.

Phase 2, channels. The lifecycle manager (open, commit, close, recover) against the MPP one-way-channel contract on testnet. Exit: a high-frequency demo runs hundreds of off-chain commitments and one on-chain close.

Phase 3, policy and reconciliation. The budget engine, reconciliation of commitments against settlement, anomaly stops. Exit: a budget-capped agent is stopped correctly and a drift case is flagged.

Phase 4, observability and polish. The dashboard, exporters, webhooks, the remaining framework adapters, and the recipe examples. Exit: v0.1 tagged and docs published.

## Security model

Non-custodial throughout. x402 settles to `PAY_TO`, channel funds live in the channel contract, and Tollway never holds funds. Replay protection comes from the settlement cache plus the naturally idempotent cumulative-commitment design. Policy enforcement is defense in depth: on chain via OpenZeppelin smart-account policies where available, application layer otherwise. Reconciliation is the safety net against a counterparty who under-settles. If a hosted service is ever run, its receipt signing key is rotatable and every receipt records the key that signed it; self-hosting removes that trust question entirely. No telemetry by default.

## Testing

Unit tests on the router, the policy engine, and the receipt format. Integration tests against a testnet facilitator for x402 and MPP charge. Channel tests against the deployed one-way-channel contract on testnet, including the recovery path. Property tests on reconciliation: random commitment streams must reconcile or flag deterministically. A duplicate-submission test asserts idempotency. The end-to-end demo exercising all three models runs in CI on every commit.

## Open questions

These are genuinely open. If you have answers or partial answers, open an issue.

1. ~~What exactly does the `@stellar/mpp` channel API expose for the recovery and dispute path, and what timeouts does the one-way-channel contract enforce?~~ Answered against `@stellar/mpp@0.6.0`: the `channel` module (`@stellar/mpp/channel`) exposes `open`, `commitment`, `close`, and `claim`, and the recovery path is `claim` gated by `closeEffectiveAtLedger` plus a `fundWaitingPeriod`. Recovery work tracks under the channel issues.
2. Which OpenZeppelin smart-account policy constraints can be expressed on chain today, and which must Tollway enforce at the application layer?
3. What is the x402 V2 service-discovery format, and should Tollway consume it for routing hints?
4. Should Tollway ship a hosted shared service in v1, or stay library-only, given the trust and operational implications?
5. What is the right default threshold (requests per minute, over what window) for the router to move a counterparty into channel mode?

## References

- Agentic payments overview: https://developers.stellar.org/docs/build/agentic-payments
- x402 on Stellar: https://developers.stellar.org/docs/build/agentic-payments/x402
- x402 quickstart: https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide
- Built on Stellar x402 facilitator: https://developers.stellar.org/docs/build/apps/x402/built-on-stellar
- MPP on Stellar: https://developers.stellar.org/docs/build/agentic-payments/mpp
- MPP channel guide: https://developers.stellar.org/docs/build/agentic-payments/mpp/channel-guide
- MPP charge vs channel (dev meeting): https://developers.stellar.org/meetings/2026/05/07
- x402 + MPP intro (dev meeting): https://developers.stellar.org/meetings/2026/04/16
- x402 blog and roadmap: https://stellar.org/blog/foundation-news/x402-on-stellar
- x402 Foundation repo and SDKs: https://github.com/x402-foundation/x402
- OpenZeppelin x402 facilitator: https://docs.openzeppelin.com/relayer/guides/stellar-x402-facilitator-guide
- x402 facilitator concepts (duplicate protection): https://docs.x402.org/core-concepts/facilitator
- Ecosystem list: https://github.com/xpaysh/awesome-x402
