---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-adapter-express": patch
"@vegaforge/tollway-adapter-fastify": patch
"@vegaforge/tollway-adapter-hono": patch
"@vegaforge/tollway-adapter-next": patch
---

Run one framework-free conformance suite across all four adapters (#107).

- Adds `@vegaforge/tollway-server/testing` with `runAdapterConformance`, a small driver interface, `toWebHeaders` and `webConformanceResponse`, and shared cases for 402s, paid handlers, rejections, a repeated payment header, differently-cased headers, and thrown gate errors.
- A thrown gate error now yields HTTP 502 `{ error: "payment backend unavailable" }` in Express, Fastify, Hono and Next. Express no longer calls `next(err)`; the fixed body avoids leaking internal messages and keeps behaviour identical across frameworks.
