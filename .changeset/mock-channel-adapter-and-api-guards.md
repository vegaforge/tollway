---
"@vegaforge/tollway-channels": minor
"@vegaforge/tollway-adapter-express": patch
"@vegaforge/tollway-adapter-fastify": patch
"@vegaforge/tollway-adapter-hono": patch
"@vegaforge/tollway-adapter-next": patch
"@vegaforge/tollway-client": patch
"@vegaforge/tollway-core": patch
"@vegaforge/tollway-observability": patch
"@vegaforge/tollway-reconcile": patch
"@vegaforge/tollway-server": patch
"@vegaforge/tollway-theme": patch
---

**`@vegaforge/tollway-channels`**: add `createMockMppChannelAdapter` for deterministic offline testing without network access. The adapter counts calls so tests can assert the single-settlement property (exactly one `openChannel`, N `signCommitment` calls, one `closeChannel`).

**All publishable packages**: fix `exports` maps to use nested conditions so `require` consumers under `node16`/`nodenext` module resolution get the correct CJS type declarations (`index.d.cts`). Add committed API Extractor reports per package; a changed public API now fails CI.
