---
date: 2026-11-20
feature: Three-model demo, high-frequency channel scenario, mock channel adapter, doc snippet checker, API Extractor reports, publint and attw
scope: feat
packages: ["@vegaforge/tollway-channels", "@vegaforge/tollway-adapter-express", "@vegaforge/tollway-adapter-fastify", "@vegaforge/tollway-adapter-hono", "@vegaforge/tollway-adapter-next", "@vegaforge/tollway-client", "@vegaforge/tollway-core", "@vegaforge/tollway-observability", "@vegaforge/tollway-reconcile", "@vegaforge/tollway-server", "@vegaforge/tollway-theme"]
scenario-impact: updated
---

# Demo scenarios, mock channel adapter, API Extractor reports, doc snippet checker

Closes #242, #243, #253, #254.

## Demo scenarios (#242, #243)

`apps/demo` is now organized as named scenarios selected by argument:

```bash
MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start -- x402
MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start -- mpp-charge
MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start -- mpp-channel
MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start -- high-frequency
MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start -- all-models
```

The `all-models` scenario runs x402, MPP charge, and MPP channel in sequence and prints a summary table. CI runs it on every commit via an explicit `tests` step.

The `high-frequency` scenario (#243) runs 500 sequential off-chain commitments through one channel, closes once, reconciles the stream, and prints throughput and p50/p95 commit latency. It proves the single-settlement property from data: exactly one `openChannel`, exactly one `closeChannel`, and N `signCommitment` calls.

## Mock MPP channel adapter (#242, #243)

`@vegaforge/tollway-channels` now exports `createMockMppChannelAdapter()`. It is deterministic (all ids and blobs derived from inputs through FNV-1a), never touches the network, and counts calls so tests can assert the single-settlement property.

## Documentation snippet checker (#253)

`scripts/check-doc-snippets.ts` extracts every TypeScript block from `README.md`, `docs/**/*.md`, and `apps/web/src/content/docs/**/*.mdx`, type-checks each against the workspace packages under strict settings, and runs blocks annotated `ts run`. Snippets annotated `ts skip=<reason>` are excluded; a bare skip without a reason is an error. Preamble files (`.preamble.ts` next to a doc) declare names the snippets rely on without cluttering the doc itself. The checker runs in `preflight.sh` and in the CI `tests` job.

28 existing snippets pass; one (the Next.js proxy example, which references a local project file) is explicitly skipped with a reason.

## API Extractor reports, publint, arethetypeswrong, provenance (#254)

Every publishable package now has a committed API Extractor report under `packages/<name>/etc/<name>.api.md`. CI fails when the built API differs from the committed report. Run `scripts/check-api-reports.sh --update` to regenerate.

All `exports` maps now use nested conditions so CJS consumers under `node16`/`nodenext` resolution get `index.d.cts` rather than `index.d.ts`.

`scripts/check-package-exports.sh` runs `publint` and `@arethetypeswrong/cli` against packed tarballs of every publishable package. It runs in preflight (after build) and in the CI `build` job.

The `release.yml` `publish` job gains `id-token: write` and `NPM_CONFIG_PROVENANCE=true`, so packages ship with npm provenance. Verify with `npm audit signatures @vegaforge/tollway-core`.
