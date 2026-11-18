# ADR for Dummies: Tollway's packages move to a name we own

- **Status:** Accepted 2026-11-18
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-npm-scope](ADR-2026-11-18-npm-scope.md)

## The idea

Code libraries are shared on npm under a family name. Tollway's packages
used the family name `@tollway`, but a different, unrelated project already
owns that name and has published there. So the packages move to
`@vegaforge`, the organisation's own name, as `@vegaforge/tollway-core`,
`@vegaforge/tollway-server` and so on.

## What people see

1. A developer installs `@vegaforge/tollway-server` instead of
   `@tollway/server`.
2. Contributors import the new names. Everything else works the same.
3. Nothing is published yet. That happens after the Drips Wave, from `main`.

## Important limitation

The maintainer has to claim the `vegaforge` organisation on npm by hand
before the first release.

## What changes

- Every package name and import path.

## What does not change

- What the code does, the version numbers, and when publishing happens.
