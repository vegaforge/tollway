# ADR for Dummies: Development, then testing, then production

- **Status:** Accepted 2026-11-18
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-branch-flow](ADR-2026-11-18-branch-flow.md)

## The idea

Tollway gets three copies of its code instead of one. `dev` is where new
work lands, `staging` is where it gets tested, and `main` is what people
actually use. Work can only move forward one step at a time, only the
maintainer can move it, and nothing moves while a check is failing.

## What people see

1. A contributor picks an issue, does the work and opens a pull request
   into `dev`. If they aim it at `staging` or `main`, a check fails and tells
   them where it should go.
2. The automated checks run. The maintainer reviews and merges into `dev`.
   Nobody else can press merge, and the button stays disabled until every
   check is green.
3. When a batch of work is ready to test, the maintainer opens a pull
   request from `dev` into `staging` and merges it.
4. When testing passes, the maintainer opens a pull request from `staging`
   into `main` and merges it. That is the production release.

## Important limitation

The other organization owner keeps the power to change these settings. They
can no longer merge, but GitHub does not let anyone lock an owner out of
the settings page.

## What changes

- New `dev` and `staging` branches, with `dev` as the default.
- Pull requests go into `dev`, never straight to `staging` or `main`.
- Only the maintainer can merge, and even the maintainer cannot skip a
  failing check.
- Package version bumps are prepared on `dev` and travel up with the code.

## What does not change

- The checks themselves: formatting, lint, types, tests, build and the
  security scan.
- How a contributor writes code, tests and release notes.
- Publishing to npm is still a manual step by the maintainer.
- The website keeps deploying from `main`.
