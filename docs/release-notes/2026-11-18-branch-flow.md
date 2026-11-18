---
date: 2026-11-18
feature: three long-lived branches, dev to staging to main
scope: chore
packages: []
scenario-impact: none
---

# Development, staging and production branches

Tollway now has three long-lived branches. Contributions go into `dev`,
`dev` is promoted to `staging` for testing, and `staging` is promoted to
`main` for production. Nothing about the packages changes.

The `branch flow` job in CI, part of the required `quality` check, rejects
any other route: a pull request into `staging` must come from `dev`, one into
`main` must come from `staging`, and neither may come from a fork. CI and
CodeQL now run for all three branches, Dependabot opens its pull requests
against `dev`, and the Changesets "Version Packages" pull request is kept on
`dev` so version bumps travel with the code. Publishing stays a manual run on
`main` and refuses to start while unreleased changesets are present.

Decision: [ADR-2026-11-18-branch-flow](../adr/ADR-2026-11-18-branch-flow.md).
