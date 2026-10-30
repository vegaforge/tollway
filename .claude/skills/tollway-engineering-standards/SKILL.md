---
name: tollway-engineering-standards
description: Engineering standards for Tollway, the orchestration, policy, and observability layer for x402 and MPP agent payments on Stellar. Read before writing or reviewing any code, comment, test, or document in this repository.
---

# Tollway Engineering Standards

These rules apply to every contributor, human or agent. The rulebook that
wraps them (directives, lifecycle, gates) is [AGENTS.md](../../../AGENTS.md).
The architectural source of truth is [docs/design.md](../../../docs/design.md).

## Architecture

Tollway is a pnpm and Turborepo monorepo. Packages are layered, and every
import points down the stack.

```text
apps            dashboard   demo   web                (private, never published)
                    |         |      |
adapters        adapter-express  adapter-fastify  adapter-next  adapter-hono
                    |
service side    server                 client   channels   reconcile   observability
                    |                     |         |          |             |
foundation      core  -------------------------------------------------------+
                theme  (design tokens, used by dashboard and web only)
```

What each layer may import:

| Package | May depend on | Must not depend on |
| ------- | ------------- | ------------------ |
| `@tollway/core` | `zod` only | any other `@tollway/*` package |
| `@tollway/theme` | nothing | any other `@tollway/*` package |
| `@tollway/server` | `core`, `@x402/core`, `@x402/stellar` | adapters, `client`, apps |
| `@tollway/client`, `channels`, `reconcile`, `observability` | `core` | each other, `server`, adapters, apps |
| `@tollway/adapter-*` | `server` (runtime), `core` (types), its own framework as a peer | another adapter, apps |
| `apps/*` | any package | another app |

Rules that follow from the table:

- `core` is the bottom. It holds types, schemas, receipts, policy, and the
  router. It never imports from the layers above it.
- `server` owns the payment logic. Adapters translate a framework's request
  and response to and from the gate's `TollwayRequest` and `GateOutcome`, and
  contain no payment logic of their own.
- Adapters never import each other. Shared adapter behaviour belongs in
  `server`, or in a shared test suite (see the conformance item below).
- The shared-service packages (`channels`, `reconcile`, `observability`) do
  not import each other. They meet in an app or in the caller's code.
- Apps sit on top and are private (`.changeset/config.json` ignores them).

What enforces it today:

- **Declared dependencies.** pnpm links a workspace package into another
  package's `node_modules` only if that package lists it in `package.json`.
  An import of an undeclared `@tollway/*` package fails to resolve in
  `pnpm typecheck` and `pnpm build`. Adding a dependency edge is therefore a
  visible `package.json` change that review must check against the table.
- **Turbo task graph.** `turbo.json` runs `build`, `typecheck`, and `test`
  after `^build`, following the same declared edges. A cycle fails the run.
- There are no TypeScript project references and no import-boundary lint rule.

Gap to close: nothing stops a package from adding a forbidden edge to its
`package.json`. A Biome `noRestrictedImports` rule in per-package `overrides`
(for example, forbid `@tollway/*` under `packages/core/**`, forbid
`@tollway/adapter-*` under `packages/adapter-*/**`) would turn the table into
a lint error. Propose it through an ADR before adding it.

A type-only import still counts as a dependency once it appears in a
published `.d.ts`. If a package's public types mention a `core` type, `core`
must be in `dependencies`, not only `devDependencies`.

## Correctness

- Verify each change before starting the next. Do not stack unverified work.
- No shortcuts: no `@ts-ignore`, no `any`, no swallowed rejection, no
  hardcoded value that hides the real path.
- Find the cause and fix it. Never patch the symptom.
- Handle an error where it happens and return a typed outcome or throw a
  `TollwayError` with a specific code. Never return a success-shaped object
  for a failure.
- Strict TypeScript stays on (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`).
- Tests prove behaviour: the happy path, a validation failure, an upstream
  failure, and the concurrency case where one exists.

## Defect checklist for the payment path

Each item matches one line in AGENTS.md and one checkbox in the pull request
template.

1. **Boundary validation.** Parse every external payload with a zod schema
   at the edge: `PAYMENT-SIGNATURE` and other x402 or MPP headers, facilitator
   `/verify`, `/settle`, and `/supported` responses, webhook bodies, and any
   value read back from a shared store such as Redis. Map it to a Tollway
   type before it goes further. A value that fails to parse is a typed
   rejection, never a silent default.
2. **Integer base units.** Amounts are integer strings in the asset's
   smallest unit. Compare and add them as `bigint`. Never use `number`,
   `parseFloat`, or `toFixed` on an amount. Stellar USDC has 7 decimals, so
   `0.001` USDC is `"10000"`.
3. **Receipts bound to the offer.** A receipt answers one offer. Before the
   gate returns a receipt, fresh or from the idempotency cache, its
   `resource`, `amount`, `asset`, `payee`, `network`, and `model` must equal
   the offer being served. A mismatch is a rejection, not a replay.
4. **Replay, nonce, and idempotency.** A signed payment settles at most once.
   The idempotency key comes from the signed payment itself (see
   `deriveNonce` in `packages/server/src/facilitator.ts`). Two concurrent
   requests with the same payment must not both reach `/settle`: hold an
   in-flight entry in process, or take a `SET NX` lock in a shared store.
   Test the concurrent case with `Promise.all`.
5. **Awaited writes.** Await or return every promise. A cache write or
   webhook send left floating becomes an unhandled rejection, which ends the
   Node process by default. Biome 2.4 does not catch every case (it misses
   `cache?.set(...)` on an interface), so add a test that makes the write
   fail and asserts the outcome.
6. **Webhook signing.** Outbound webhooks carry a signature over the body
   and a timestamp, and the package exports the matching verify function.
   Tests cover a valid, a forged, and a replayed delivery.
7. **Adapter conformance.** A change to gate behaviour is exercised through
   all four adapters, including what happens when the gate throws. Adapters
   must agree on status codes and headers.
8. **No invented protocol surface.** x402 and MPP code must match the
   installed `@x402/core`, `@x402/stellar`, and `@stellar/mpp` versions. Read
   the package source under `node_modules` or current upstream docs. x402 V2
   headers are `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
   `PAYMENT-RESPONSE`; `X-PAYMENT` is the V1 name. Networks cross the wire as
   CAIP-2 ids (`stellar:testnet`, `stellar:pubnet`).
9. **No custody.** Funds settle to `payTo` or stay in the channel contract.
   Tollway never holds or forwards value.
10. **Changeset.** A change to a publishable package under `packages/` ships
    a `.changeset/*.md`. Run `pnpm changeset`.
11. **Release note.** A change under `packages/*/src/` or `apps/*/src/` adds
    a file under `docs/release-notes/`. CI enforces this.
12. **Preflight.** `./scripts/preflight.sh` passed in full before review.

## Comments and naming

- Write every comment by hand, in plain English. Short, clear, specific.
- Default to no comment. A comment explains why, or a non-obvious what.
- Point at the design document section a piece of code implements, the way
  existing files do (`See docs/design.md, "Design notes"`).
- No filler and no marketing tone. Do not use em-dashes; use a comma, a
  colon, or a period.
- Name things for what they are.

## Documentation

- Technically correct and specific. Define a term the first time it appears.
- Examples must run or typecheck against the current API. Check them.
- Status claims ("implemented", "not yet") must match the code. Link the
  tracking issue for anything open.

## Git and review

- One issue, one branch, one pull request. Prefixes: `feat/`, `fix/`,
  `chore/`, `docs/`, `test/`.
- Never push to `main`. Squash merges only.
- Commits are atomic, in Conventional Commits form, and say what changed and
  why.
- Never add AI co-author trailers or session footers to commits, pull
  requests, or files.
- Never commit or push on someone's behalf without being asked.
- Security defects go through SECURITY.md, never a public issue.

## Tooling

- pnpm only, at the version in `packageManager`. Node from `.nvmrc`.
- Biome formats and lints. `pnpm lint` fails on warnings.
- Vitest for tests. Libraries build with tsup (ESM, CJS, and declarations).
- Run `./scripts/preflight.sh` before opening a pull request. CI runs the
  same gates.
- When a task needs a library, read its current docs or installed source
  first. Do not code from memory.
