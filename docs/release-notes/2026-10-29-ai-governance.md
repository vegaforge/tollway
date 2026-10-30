---
date: 2026-10-29
feature: Contributor rulebook, local Git hooks, five-gate preflight, and a split CI with a single required check
scope: chore
packages: []
scenario-impact: none
---

# AI governance and contributor gates

Contributors and coding agents now have one rulebook, `AGENTS.md`, and the
routine checks run before code reaches review.

- `pnpm install` sets up two Git hooks through lefthook. A commit formats and
  lints the staged files. A push runs `./scripts/preflight.sh --fast`.
- `./scripts/preflight.sh` runs format check, lint, typecheck, tests, and the
  production build in one command.
- `pnpm lint` now fails on Biome warnings as well as errors.
- CI runs `checks`, `tests`, and `build` in parallel, and a `quality` job that
  passes only when all three succeed. CI has read-only permissions and uses
  the Node version from `.nvmrc`. The old single `verify` job is gone, so the
  `main` ruleset now requires `quality` instead.
- A change to package or app source must include a release note under
  `docs/release-notes/`. CI enforces this.
- New templates: ADRs, plans, release notes, a Wave task issue form, and an
  extended pull request template.

No package or app behaviour changed. Decision record:
[ADR-2026-10-29-ai-governance](../adr/ADR-2026-10-29-ai-governance.md).
