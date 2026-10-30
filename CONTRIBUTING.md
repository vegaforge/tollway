# Contributing to Tollway

Thank you for your interest in contributing. Tollway is a pnpm monorepo designed so that contributors can pick up one package without building the world. Each adapter, each example, the dashboard widgets, and the reconciliation engine are independent, well-scoped pieces you can own without deep context.

The full rulebook, for people and for coding agents, is [AGENTS.md](AGENTS.md). The architecture rules and the payment-path defect checklist are in [`.claude/skills/tollway-engineering-standards/SKILL.md`](.claude/skills/tollway-engineering-standards/SKILL.md). This page is the short version.

## Prerequisites

- Node 22 or later
- pnpm 10 or later (`corepack enable` or `npm i -g pnpm`)

## Getting started

```bash
git clone https://github.com/vegaforge/tollway.git
cd tollway
pnpm install
./scripts/preflight.sh
```

`pnpm install` also installs two Git hooks through [lefthook](https://lefthook.dev):

- **pre-commit** runs Biome on the files you staged and re-stages its fixes.
- **pre-push** runs `./scripts/preflight.sh --fast`: everything except the build.

If the hooks are missing (for example, you installed with scripts disabled), run `pnpm exec lefthook install`.

Useful commands:

| Command | What it does |
| ------- | ------------ |
| `./scripts/preflight.sh` | Run all five gates: format check, lint, typecheck, tests, build |
| `./scripts/preflight.sh --fast` | The same, without the build |
| `pnpm build` | Build all packages through Turborepo |
| `pnpm test` | Run all Vitest suites |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm lint` | Biome lint and format check; warnings fail |
| `pnpm format:check` | Biome format check only |
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

1. Comment on the issue and wait to be assigned. Pull requests for issues you are not assigned to are closed without review.
2. Fork the repository and create a branch from an up-to-date `main` (for example `feat/adapter-hono-middleware`).
3. For a bug, write the failing test first, then the fix.
4. If the change touches `packages/*/src` or `apps/*/src`, add a release note: copy `docs/release-notes/TEMPLATE.md` to `docs/release-notes/<YYYY-MM-DD>-<topic>.md`. CI fails without it.
5. If the change affects a publishable package, also add a changeset: `pnpm changeset`. The release note is the human summary; the changeset is the version bump.
6. Run `./scripts/preflight.sh`. All five gates must pass.
7. Open a pull request using the template. The body must include `Closes #<issue>`.

Larger changes (a new public API, a change to the payment path, a new package) start with a short design proposal. See Directive 2 in [AGENTS.md](AGENTS.md) and the templates in `docs/adr/`.

Commit messages follow Conventional Commits, for example `feat(channels): add idle-timeout close heuristic`.

## Reporting bugs and requesting features

Use the issue templates. For security vulnerabilities, do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
