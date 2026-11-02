---
date: 2026-10-30
feature: Required security check that blocks malicious pull requests
scope: chore
packages: []
scenario-impact: none
---

# Security gate for pull requests

Every pull request now runs a required `security` check next to `quality`. It
blocks pull requests that carry compiled or archived files, invisible Unicode,
obfuscated code, unsafe SVGs, symlinks or submodules, dependencies from outside
the official registries, known malicious packages, new known vulnerabilities,
new install scripts, code that steals credentials or secrets, unsafe workflow
changes, and known malware signatures. Changes to files that can run code need
a maintainer's approval on the latest commit.

`.github/workflows/pr-security.yml` runs six read-only jobs: `diff-scan`
(`scripts/security/scan_diff.py`), `malicious-patterns` (Semgrep with the rules
in `.github/semgrep/`), `sensitive-paths` (`scripts/security/check_review.py`),
`dependencies` (OSV-Scanner, dependency review), `workflows` (zizmor) and
`malware-signatures` (ClamAV). The checks are taken from the base branch, and no
job installs or runs the pull request's code. Knip now runs in `quality` and in
preflight, and fails on unused or undeclared dependencies.

Also in this change: every action in `codeql.yml` and `release.yml` is pinned to a commit, `release.yml` grants write access only to the Changesets job, and the unused `@tollway/observability` dependency is gone from the dashboard.

Decision record: `docs/adr/ADR-2026-10-29-pr-security-gate.md`.
