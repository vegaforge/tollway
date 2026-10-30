## Summary

<!-- What this changes and why, in a few sentences. Name the package or app it touches. -->

## Related issue

<!-- Required. One line, for example: Closes #12 -->

Closes #

## Type of change

<!-- Keep what applies, delete the rest. -->

- Bug fix
- Security fix
- New feature
- Documentation
- Refactor or chore

## Release note and changeset

- [ ] Release note added in `docs/release-notes/<YYYY-MM-DD>-<topic>.md` (required when `packages/*/src` or `apps/*/src` changed)
- [ ] **scenario-impact** in the release note: `updated` | `needs_automation` | `none`
- [ ] A changeset is included if a publishable package under `packages/` changed (`pnpm changeset`)

## Checklist

See AGENTS.md and `.claude/skills/tollway-engineering-standards/SKILL.md` for what each item means.

- [ ] **Assigned**: I was assigned the linked issue before opening this pull request.
- [ ] **Branch**: the work was done on its own branch, cut from an up-to-date `main`.
- [ ] **Approval**: the ADR pair or plan was approved by the maintainer (non-trivial changes only).
- [ ] **Test first**: a bug fix is locked by a test that failed before the fix.
- [ ] **Boundary validation**: external payloads (x402 and MPP headers, facilitator responses, webhook bodies, shared-store reads) are parsed with a schema and mapped to Tollway types.
- [ ] **Integer base units**: amounts stay integer strings in the asset's smallest unit and are compared as `bigint`. No floats.
- [ ] **Receipt binding**: any receipt returned, fresh or cached, matches the offer being served (resource, amount, asset, payee, network, model).
- [ ] **Replay and idempotency**: a signed payment settles at most once, including under concurrent duplicates.
- [ ] **Awaited writes**: no floating promises on the payment path (cache writes, webhook sends).
- [ ] **Adapters**: gate behaviour changes are covered through all four adapters.
- [ ] **Layering**: imports point down the stack; adapters do not import each other; no new forbidden dependency edge.
- [ ] **No custody**: nothing makes Tollway hold or route funds.
- [ ] **Preflight**: `./scripts/preflight.sh` passed with zero errors and zero warnings.

## How this was verified

<!-- The exact commands you ran and what they printed. For the payment path, include the demo run, for example MOCK_MODE=true pnpm --filter @tollway/demo start. -->

## Notes for the reviewer
