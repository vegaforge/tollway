---
date: 2026-11-24
feature: Vercel AI SDK integration, a budgeted paid_fetch tool for agents
scope: feat
packages:
  - "@vegaforge/tollway-ai-sdk"
scenario-impact: none
---

# A paid_fetch tool for the Vercel AI SDK

The new `@vegaforge/tollway-ai-sdk` package exports `createPaidFetchTool`, which gives a model a `paid_fetch` tool built with the AI SDK's `tool()` helper. The model asks for a URL, the tool fetches it through the paid fetch the host provides, and the model gets the status, a body capped at 32 KiB by default with truncation flagged, and a receipt summary without the signature. After a payment, the budget left for that asset and payee is included when the policy engine reports it.

Because a model chooses the URLs, the tool refuses origins outside `allowedOrigins` and methods outside `methods` (default `GET`) before any request, refuses payment and credential headers from the model, asks the paid fetch not to follow redirects, and withholds a response from another origin. A policy block or an offer-check failure, such as a price over the per-call ceiling, returns `{ status: "blocked", rule, detail }` so the run continues; other errors, including aborts, are thrown. The AI SDK's `abortSignal` is forwarded to the paid fetch.

`ai` 7 and `zod` 4 are peer dependencies. The tool takes any paid fetch with the `createPaidFetch` shape (#201). `examples/agent-tools` runs it under `generateText` with the AI SDK's mock model. Docs: `apps/web/src/content/docs/ai-sdk.mdx`.

Closes #208. Pull request: #347.
