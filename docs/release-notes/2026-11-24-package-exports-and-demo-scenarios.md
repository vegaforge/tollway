---
date: 2026-11-24
feature: Guarded package exports and public API reports, plus demo scenarios for x402 and MPP charge
scope: chore
packages: ["@vegaforge/tollway-adapter-express", "@vegaforge/tollway-adapter-fastify", "@vegaforge/tollway-adapter-hono", "@vegaforge/tollway-adapter-next", "@vegaforge/tollway-channels", "@vegaforge/tollway-client", "@vegaforge/tollway-core", "@vegaforge/tollway-observability", "@vegaforge/tollway-reconcile", "@vegaforge/tollway-server", "@vegaforge/tollway-service", "@vegaforge/tollway-theme"]
scenario-impact: none
---

# Package export checks, API reports and demo scenarios

**Published packages (#254).** Every publishable package's export map nests
its conditions, so `import` and `require` each resolve their own type
declarations. Three checks run after the build, in preflight and in the CI
`build` job:

- `scripts/check-api-reports.sh` compares each package's API Extractor report
  in `packages/<name>/etc/` with the built declarations, and fails on any
  difference. `--update` rewrites the reports after an agreed API change.
- `scripts/check-package-exports.sh` runs publint and arethetypeswrong on each
  packed tarball.
- `scripts/check-package-consumers.sh` installs every tarball into a fresh
  project and loads each entry point from ESM and from CommonJS under node16.

The consumer check found that `@vegaforge/tollway-adapter-next/proxy` could
not be loaded by plain Node ESM, because `next` publishes no export map and the
adapter imported `next/server`. It now imports `next/server.js`.

API Extractor also fails on doc comments that link to something the package
does not export. Four links in `@vegaforge/tollway-observability`'s hub
interface named a member without its interface (`{@link flush}`); they now
name it in full (`{@link ObservabilityHub.flush}`).

Releases publish with npm provenance (`id-token: write` and
`NPM_CONFIG_PROVENANCE`, which `changeset publish` passes to `npm publish`
through pnpm). CONTRIBUTING.md, "Public API reports", says how to verify it.

**Demo scenarios (part of #242).** `apps/demo` runs named scenarios: `x402`
(the default, unchanged), `mpp-charge` (the same route with only the model
switched) and `all-models`, which CI runs in mock mode on every commit. The MPP
channel scenario waits for the gate to accept vouchers (#173).

Pull request: #303.
