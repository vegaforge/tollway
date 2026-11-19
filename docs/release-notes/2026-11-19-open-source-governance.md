---
date: 2026-11-19
feature: contribution rules for an open-source project, and a faster security check
scope: chore
packages: []
scenario-impact: none
---

# Contribution rules that fit an open-source project

Contributors no longer write ADRs or plans for Wave issues: the issue is the
approved design, a change of approach is agreed in the issue thread, and only
the maintainer marks a design as Accepted. AGENTS.md has a new
"Contributors" section and CONTRIBUTING a "Before you push" box.

A new `contribution rules` job, part of the required `security` check and
read from the base branch, fails early and in plain words when a contributor's
pull request does not close exactly one issue, closes one they are not
assigned to, or marks an ADR as Accepted. Maintainers and Dependabot are
exempt.

The `sensitive paths` job is now called `maintainer review`, and its message
says the contributor has nothing to fix.

The `malware signatures` job restores the ClamAV signature database from a
daily cache kept warm by a new `ClamAV signature cache` workflow, so it fetches
only the day's update instead of about 200 MB on every run. Runs for the same
pull request no longer cancel each other across events, so approving a pull
request does not leave a cancelled, failing `security` check behind.

Decision: ADR-2026-11-19-open-source-governance.
