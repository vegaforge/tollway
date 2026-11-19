---
date: 2026-11-19
feature: clear the open Dependabot security alerts in the lockfile
scope: chore
packages: []
scenario-impact: none
---

# Dependency security updates

Every dependency was updated within its allowed range, and four transitive
dependencies are now pinned to patched versions with pnpm overrides:
`axios` 1.20 or later (the previous override pinned 1.18.0, which is still
affected), `toml` 5.0.1 (pulled in by `@stellar/stellar-sdk` 15; its `parse`
API is unchanged), `vite` 7.3.8 and `esbuild` 0.28.2. `vite` is also declared at
the workspace root, because overrides do not reach auto-installed peers; a new
`knip.jsonc` records why Knip should not flag it.

This clears 91 of the 92 open npm alerts, including the critical `proxy-addr`
one. The remaining `zod` 3 alert comes from `@x402/core` 2.16 and goes away
with the x402 upgrade tracked in #259. Biome stays at 2.4.16: 2.6 starts
formatting Markdown, which is a toolchain change of its own.

The six Python alerts (`mcp`, `opentelemetry-api`) come from Semgrep, which
pins those versions up to its latest release (1.186.0). They only exist in the
CI environment that runs the scan.
