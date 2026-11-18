---
date: 2026-11-18
feature: the Next.js adapter is tested against a patched Next 15
scope: chore
packages: []
scenario-impact: none
---

# The Next.js adapter tests against a patched Next 15

`@vegaforge/tollway-adapter-next` declares Next `^14 || ^15` as an optional
peer but had no development copy of its own, so the workspace lockfile held
an auto-installed `next@15.5.19`. That version carries 14 open security
advisories, three of them critical (remote code execution in image
optimization). The adapter now has `next@^15.5.29` as a development
dependency, which takes the vulnerable version out of the lockfile and lets
Dependabot keep it current.

A new test runs `withPaywall` against a real `NextRequest` from
`next/server`, the type App Router handlers receive, instead of only a plain
`Request`. The published package does not change. Support for Next 16 is
tracked separately.
