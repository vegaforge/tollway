---
date: 2026-11-24
feature: The gate runs on Cloudflare Workers, Deno and Bun, checked in CI on every pull request
scope: feat
packages: ["@vegaforge/tollway-server"]
scenario-impact: none
---

# Edge runtimes

A new CI job runs one gate scenario on workerd (through Miniflare), Deno 2.9.8 and Bun 1.2.21 against the packages' built ESM output. An unpaid request gets 402, and a paid one settles and returns a receipt that verifies, through the Hono adapter and a Next-style `withPaywall` handler and through `createHttpFacilitator` against a stubbed facilitator endpoint. The job is part of `quality`. The scenario lives in `tests/edge`, separate from the Node suites, so a runtime failure is attributed to its runtime.

Running it found one defect, fixed at its source. Each runtime reports a failed `fetch` differently, and the gate only recognised Node's `TypeError: fetch failed`. On Bun (`ConnectionRefused`) and workerd (`Network connection lost.`), an MPP charge settle that lost its answer was reported as a rejection, which frees the payment even though the charge may have landed. It now fails, and the payment is held. A refused connection on Deno and Bun is now recognised as never sent, so facilitator failover works there too. Tests cover the error each runtime actually throws, captured from each.

The CAIP-2 network ids are now defined in the server rather than imported from `@x402/stellar`'s package entry, with a test that they equal upstream's. `deriveMppChargeNonce` has a regression test pinning its output.

Workers need the `nodejs_compat` flag: the Stellar SDK imports `buffer` and the x402 Bazaar extension imports `url`. A minimal Worker using `@vegaforge/tollway-server` is about 870 KiB, 210 KiB gzipped; CI fails if it grows past 235,000 bytes gzipped. That budget is pending the maintainer's decision: it was 200,000, and #342's local Stellar pre-validation brings the Stellar SDK's XDR layer into the gate, taking the minimal Worker from 153,048 to 214,619 bytes gzipped. The new "Supported runtimes" docs page lists versions, limits and a minimal Workers example.

Closes #163. Pull request: #338.
