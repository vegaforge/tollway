# Contributing to Tollway

Thank you for your interest in contributing. Tollway is a pnpm monorepo designed so that contributors can pick up one package without building the world. Each adapter, each example, the dashboard widgets, and the reconciliation engine are independent, well-scoped pieces you can own without deep context.

## Prerequisites

- Node 22 or later
- pnpm 10 or later (`corepack enable` or `npm i -g pnpm`)

## Getting started

```bash
git clone https://github.com/vegaforge/tollway.git
cd tollway
pnpm install
pnpm build
pnpm test
```

Useful commands:

| Command | What it does |
| ------- | ------------ |
| `pnpm build` | Build all packages through Turborepo |
| `pnpm test` | Run all Vitest suites |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm lint` | Biome lint and format check |
| `pnpm lint:fix` | Apply Biome fixes |
| `pnpm --filter @tollway/core test` | Run one package's tests |

## Where to start

- Browse the [open issues](https://github.com/vegaforge/tollway/issues). Each is scoped to a package, carries acceptance criteria, and notes any prerequisite it depends on.
- Issues labeled [`difficulty:good-first-issue`](https://github.com/vegaforge/tollway/issues?q=is%3Aissue+is%3Aopen+label%3Adifficulty%3Agood-first-issue) are the friendliest starting points, biased toward the framework adapters and example apps.
- The [design document](docs/design.md) is the source of truth for architecture and scope. Stub code carries TODO comments pointing at the relevant section.

## Project conventions

- TypeScript strict mode everywhere. No `any` in `@tollway/core`.
- Lint and format with Biome. Run `pnpm lint:fix` before pushing.
- Tests with Vitest. New behavior needs a test.
- Library packages build with tsup (ESM, CJS, and type declarations).
- Do not invent x402 or MPP API surfaces. Where the exact SDK call is unknown, keep a typed interface and a TODO pointing at the upstream docs.
- Tollway never custodies funds. Changes that would make Tollway hold value will not be accepted. See the [security model](docs/design.md#security-model).

## Pull request workflow

1. Fork the repository and create a branch from `main` (for example `feat/adapter-hono-middleware`).
2. Make your change with tests.
3. If the change affects a publishable package, add a changeset: `pnpm changeset`.
4. Make sure `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass locally.
5. Open a pull request using the template. Link the issue it closes.

Commit messages follow Conventional Commits, for example `feat(channels): add idle-timeout close heuristic`.

## Reporting bugs and requesting features

Use the issue templates. For security vulnerabilities, do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
