---
"@vegaforge/tollway-server": patch
---

Recognise a failed `fetch` on every runtime the gate supports: Bun's `ConnectionRefused` and workerd's `Network connection lost.` are now network failures, so an MPP charge settle that loses its answer on Bun or Workers fails instead of being reported as a rejection, and a refused connection on Deno or Bun counts as never sent. The x402 CAIP-2 network ids are defined locally instead of imported from the `@x402/stellar` package entry.
