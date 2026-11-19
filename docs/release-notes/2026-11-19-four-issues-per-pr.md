---
date: 2026-11-19
feature: a contributor's pull request may close up to four assigned issues
scope: chore
packages: []
scenario-impact: none
---

# Up to four issues per pull request

Contributors may work on up to four assigned issues at once and close them in
one pull request. The `contribution rules` check now fails a pull request that
closes no issue or more than four, and checks every closed issue for
assignment, naming each one the author is not assigned to. AGENTS.md and
CONTRIBUTING describe the new limit.

Decision: ADR-2026-11-19-open-source-governance (amendment).
