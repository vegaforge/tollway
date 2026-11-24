---
"@vegaforge/tollway-adapter-express": patch
"@vegaforge/tollway-adapter-fastify": patch
"@vegaforge/tollway-adapter-hono": patch
"@vegaforge/tollway-adapter-next": patch
"@vegaforge/tollway-channels": patch
"@vegaforge/tollway-client": patch
"@vegaforge/tollway-core": patch
"@vegaforge/tollway-observability": patch
"@vegaforge/tollway-reconcile": patch
"@vegaforge/tollway-server": patch
"@vegaforge/tollway-service": patch
"@vegaforge/tollway-theme": patch
---

Every export map now nests its conditions, so `import` resolves `.d.ts` and `.js` and `require` resolves `.d.cts` and `.cjs`. CommonJS consumers under `moduleResolution: node16` now get the CommonJS type declarations. `@vegaforge/tollway-adapter-next/proxy` imports `next/server.js`, so plain Node ESM can load it; before, only a bundler could resolve `next/server`. Packages are now published with npm provenance.
