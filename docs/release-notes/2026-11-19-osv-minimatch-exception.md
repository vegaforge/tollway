---
date: 2026-11-19
feature: time-boxed dependency-scan exception for minimatch under TypeDoc
scope: chore
packages: []
scenario-impact: none
---

# Dependency-scan exception for minimatch under TypeDoc

The API reference for the docs site (#252) is generated with TypeDoc. Every
TypeDoc release up to 0.28.20 depends on `minimatch` ^10, and every 10.x is
affected by GHSA-g3hv-75wg-m249, a denial of service from a crafted glob
pattern. The patched `minimatch` 11 removes a function TypeDoc calls, so it
cannot be forced in with an override.

`.github/security/osv-scanner.toml` now lists the advisory with its reason and
an expiry of 2027-02-28, after which the `dependencies` check reports it again.
The risk does not reach users: TypeDoc runs only while the docs site builds,
never in a published package, and the only patterns it matches come from
`apps/web/typedoc.json` in this repository. Remove the entry once a TypeDoc
release accepts `minimatch` 11.
