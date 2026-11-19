# Plan: create-tollway scaffolder (2026-11-18)

- **ADR:** [ADR-2026-11-18-create-tollway](../adr/ADR-2026-11-18-create-tollway.md)
- **Issue:** #257

## Boundaries

Add a publishable package under `packages/create-tollway`, source templates and tests, generated tarball integration checks, and docs/release metadata. Do not change existing adapters or duplicate the standalone apps.

## Interfaces

CLI flags: `--template express|hono|next`, `--dir`, `--package-manager`, `--yes`, and `--force`. The generated app exposes one paid route and an end-to-end mock payment test.

## State changes

Only generated project files are written. Directory creation is guarded; `.env` is never overwritten and no secret key is generated.

## Test strategy

Test CLI argument parsing, directory safety, existing `.env` preservation, dependency version substitution, and each generated project's typecheck and end-to-end verified-receipt flow using packed local workspace packages.

## Steps

1. Implement package manifest, CLI entry point, option parsing, prompts, and safe output directory handling.
2. Add real TypeScript templates for Express, Hono, and Next 15, with mock facilitator, route, env example, README, and paid-request test.
3. Add package-version substitution and parser/filesystem unit tests.
4. Add a temporary-project harness that packs required workspace packages and runs generated typecheck/tests for all templates.
5. Configure lint, typecheck, and knip treatment for template files; document the commands in README and the docs site.
6. Add changeset and release note; run full preflight and inspect package contents.
