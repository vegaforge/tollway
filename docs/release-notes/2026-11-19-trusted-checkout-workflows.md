---
date: 2026-11-19
feature: fix the security check's self-test after the advisory list test
scope: fix
packages: []
scenario-impact: none
---

# Fix the security check's self-test

`diff scan` runs the security test suite from a sparse copy of the base
branch. That copy held `scripts/security`, `.github/semgrep` and
`.github/security`, but not `.github/workflows`, so the new
`test_advisory_exceptions.py` (which reads `pr-security.yml`) failed with
`FileNotFoundError` on every pull request opened or updated after it merged.
The sparse copy now includes `.github/workflows`. It is still the base
branch's copy, so nothing from the pull request is trusted.
