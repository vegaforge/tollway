---
date: 2026-11-24
feature: Observe fee-sponsor balances and alert before funds run low
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-server", "@vegaforge/tollway-observability"]
scenario-impact: updated
---

# Fee-sponsor balance monitoring

Services can monitor native XLM balances using `createSponsorMonitor`, with an
explicit sponsor list or facilitator signer discovery. Integer stroops readings
flow to a structural sink, keeping server independent of observability. The hub
stores the latest attempt per network and account. Failed reads are stale, carry
the error, and never expose an old balance as current.

The new `sponsor.low_balance` webhook event fires once per low-balance episode;
configurable hysteresis prevents repeated alerts near the threshold. Polling is
serial, uses an unref'd timer on Node (other runtimes return a plain number,
which needs no unref), and supports start/stop. Sponsor balance and stale
gauges can be rendered with `renderFeeSponsorMetrics`, ready for #218's separate
payment exporter. Tollway never funds, tops up, transfers, or signs for sponsors.

The demo prints a startup reading, using an injected fake reader in mock mode.
See `docs/scenarios/fee-sponsor-monitor.md` and the observability docs for
configuration, metric labels, and the limits of signer discovery. Implements
the behavior requested in #221; no ADR was required for the assigned issue.
