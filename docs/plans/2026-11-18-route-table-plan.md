# Plan: Framework-agnostic paid route table (2026-11-18)

- **ADR:** [ADR-2026-11-18-route-table](../adr/ADR-2026-11-18-route-table.md)
- **Issue:** #261

## Boundaries

Implement route compilation and matching in `packages/server`; add thin route-table handlers in Express, Fastify, Next, and Hono; update README and web docs. Do not change settlement protocol behavior or add a router dependency.

## Interfaces

`createRouteTable(routes, deps)` returns a `RouteTable` with `match(method, url)`, `list()`, and route metadata. New adapter functions accept a `RouteTable` and pass through unmatched requests.

## State changes

All gates in one table share the configured settlement cache and one process-local in-flight settlement map. Per-route offer config remains immutable after construction.

## Test strategy

Start with construction validation, precedence, normalization, no-overlap property-style coverage, list output, and cross-route 409 replay tests. Add adapter tests for matched success, challenge, rejection, free-route pass-through, and shared table behavior in all four frameworks.

## Steps

1. Inspect the current gate's settlement context and protocol config sources; finalize canonical normalization and overlap validation.
2. Add the table types, compiler, matcher, listing API, and red tests.
3. Refactor gate construction to accept a shared internal settlement context and prove cross-entry duplicate guarantees.
4. Add one route-table adapter entry point per framework and conformance tests.
5. Add README and docs examples, changesets, and release notes.
6. Run the full preflight and exercise matched/free routes through a focused framework fixture.
