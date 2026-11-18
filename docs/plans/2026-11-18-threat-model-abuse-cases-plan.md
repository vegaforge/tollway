# Plan: Threat model and abuse-case verification (2026-11-18)

- **ADR:** [ADR-2026-11-18-threat-model-abuse-cases](../adr/ADR-2026-11-18-threat-model-abuse-cases.md)
- **Issue:** #256

## Boundaries

Change threat-model/security/design documentation, focused tests under `packages/server` and `packages/core`, the test cross-check script, and the CI test invocation. Do not alter payment behavior. Do not publish newly discovered vulnerability details; report them privately and represent them only as open in the public model.

## Interfaces

No public package API changes. Abuse tests use the existing gate, mock facilitator, in-memory settlement cache, receipt signing/verifying APIs, and a fake `RedisLikeClient` for shared-lock behavior. The consistency check consumes stable case ids and test declarations.

## State changes

No production state changes. Tests may instantiate local caches and fake Redis state to model one or two processes.

## Test strategy

First add one `describe` per case id for settled-payment replay, cross-offer replay, same-process concurrent duplicates, two-process duplicates with shared locking, tampered receipt fields, untrusted receipt key, malformed and oversized headers, and repeated payment headers. Verify existing behavior without network access. Add the table-to-suite cross-check and ensure it fails when a defended id lacks a declaration. Do not add skipped or expected-to-fail tests for open paths.

## Steps

1. Inspect gate, header, cache, receipt, and Redis lock implementations and current test seams; map concrete paths in the draft threat model.
2. Add the abuse tests and confirm each purported defense. If a defect appears, stop work on its details, report privately per `SECURITY.md`, and leave that case open in public documentation.
3. Add the threat model table, flow diagrams, scope boundaries, and review cadence; link it from `SECURITY.md` and `docs/design.md`.
4. Add the defended-row/test cross-check to `pnpm test` and CI.
5. Add the release note and run affected tests plus the full preflight suite.
