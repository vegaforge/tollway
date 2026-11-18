---
date: 2026-11-18
feature: the Release workflow only runs when started by hand
scope: chore
packages: []
scenario-impact: none
---

# Versioning runs by hand until releases start

Every merge into `dev` used to open a Changesets "Version Packages" pull
request. Nothing is being published until after the Drips Wave, so those pull
requests only added noise. The Release workflow now runs only when a
maintainer starts it: on `dev` with "version" set to prepare the version
pull request, and on `main` with "publish" set to publish. Branch rules and
the publish guard are unchanged.

Decision: ADR-2026-11-18-branch-flow (amendment).
