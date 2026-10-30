# ADR for Dummies: House rules and automatic checks for contributors

- **Status:** Accepted 2026-10-29
- **Date:** 2026-10-29
- **Technical ADR:** [ADR-2026-10-29-ai-governance](ADR-2026-10-29-ai-governance.md)

## The idea

Tollway handles other people's payments, and more people (and coding agents)
are about to contribute. This change writes the house rules down in one place
and makes the computer check the routine parts, so a mistake is caught on the
contributor's machine instead of in review or, worse, after release.

## What people see

1. A contributor clones the repository and runs `pnpm install`. Two Git hooks
   are installed without any extra step.
2. When they commit, the files they changed are formatted and linted, and any
   automatic fixes are added to the commit.
3. When they push, the project's checks run on their machine: formatting,
   lint, types, and tests. If anything fails, the push stops and says why.
4. On GitHub, the pull request runs three check groups and one summary check
   called `quality`. The maintainer merges only when `quality` is green.
5. The pull request form asks for the issue it closes, a short release note,
   and a checklist of the mistakes that matter most for payments.
6. Before a large change, the contributor (human or agent) writes a short
   proposal like this one and waits for the maintainer to say yes.

## Important limitation

Hooks run on the contributor's machine, and anyone can skip them. They are a
convenience. The real gate is the `quality` check on GitHub. The rules on
`main` currently require a check called `verify`, which this change removes,
so the maintainer has to switch that rule to `quality` when merging.

## What changes

- New rulebook files: `AGENTS.md`, `CLAUDE.md`, and an engineering standards
  guide.
- New scripts: `scripts/preflight.sh` (all checks in one command) and a
  release-note check.
- Lint warnings now fail the build, not just errors.
- CI is split into clear steps and has the minimum permissions it needs.
- New templates for proposals, plans, release notes, and Wave issues.
- The private issue-seeding script stays private; other scripts in
  `scripts/` are now shared.

## What does not change

- No library or app code changes. Every package behaves exactly as before.
- The release and CodeQL workflows are untouched.
- Commands contributors already know (`pnpm build`, `pnpm test`,
  `pnpm typecheck`) still work the same way.
