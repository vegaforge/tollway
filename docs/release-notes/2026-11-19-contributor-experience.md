---
date: 2026-11-19
feature: clearer CI failures for contributors, and a held Biome version
scope: chore
packages: []
scenario-impact: none
---

# Clearer CI failures for contributors

Fixes for the snags the first Wave pull requests hit:

- When `pnpm install --frozen-lockfile` fails, CI now says what to do: merge
  the latest `dev`, run `pnpm install`, commit `pnpm-lock.yaml`, and keep the
  versions `dev` already has.
- When Semgrep cannot parse a changed file, the security check names the line
  and what the parser rejected, and suggests a rewrite (the common case is an
  inline `typeof import("pkg")` type).
- CONTRIBUTING gains a "When CI fails or does not run" table covering every
  failure seen so far, including a pull request with no checks at all because
  its branch conflicts with `dev`.
- Biome is held at 2.4.16, and Dependabot no longer proposes its minor or major
  updates: 2.6 starts formatting Markdown, which would turn every open pull
  request red at once. That upgrade belongs in a deliberate toolchain change.
