---
date: 2026-10-29
feature: README and docs site state what is implemented and what is open
scope: docs
packages: []
scenario-impact: none
---

# README and docs status accuracy

The README Status section and the docs site's "What is built today" said the
policy engine, reconciliation, observability, the channel lifecycle, and the
Fastify, Next.js, and Hono adapters were typed interfaces. All of them are
implemented and tested on `main`. Both pages now list what works per package
and link a tracking issue for each open item.

The README and the getting-started page also said that dropping `MOCK_MODE`
runs the demo against a testnet facilitator. That does not work today, and
both pages now say so and point at #113, which fixes the demo defaults.

Smaller corrections: the x402 request path section notes that the wire format
is not yet x402 V2 compatible (#43), the model router page notes that traffic
promotion to channel mode is open (#105), the channels page notes that
`recover` and a real `@stellar/mpp` adapter are open (#38, #101), and the
dashboard data contracts guide no longer says the observability hub is
unshipped.

No code changed.
