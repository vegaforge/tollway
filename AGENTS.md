# Engineering Standards and AI Governance Rulebook

This file is the rulebook for every coding agent that works in this repository
(Claude Code, Codex, Antigravity, Qwen Code, and custom harnesses). Human
contributors follow the same rules; see [CONTRIBUTING.md](CONTRIBUTING.md).

The craft rules (architecture, correctness, comments, the defect checklist in
detail) live in
[`.claude/skills/tollway-engineering-standards/SKILL.md`](.claude/skills/tollway-engineering-standards/SKILL.md).
Read both before writing or reviewing code.

Tollway moves money on behalf of other people. A payment gate that settles
twice, or lets one payment unlock two resources, is a loss for someone. The
rules below exist so that nothing depends on an agent remembering to be careful.

---

## Directives

### Directive 1: `main` is read-only, and every branch lives in a worktree

`main` is the only long-lived branch. Agents never commit or push to it.

All work happens in a Git worktree cut from a freshly fetched `origin/main`:

```bash
git fetch origin main
git worktree add .worktrees/<branch-dashed> -b <branch> origin/main
cd .worktrees/<branch-dashed>
pnpm install --frozen-lockfile
```

`.worktrees/` is ignored by Git. Never assume a local `main` is current.

### Directive 2: Two ADRs and explicit human approval before non-trivial work

Before a non-trivial feature, an architectural change, a change to a public
package API, or a change to the payment path, the agent writes two
Architecture Decision Records under `docs/adr/`:

1. `docs/adr/ADR-<YYYY-MM-DD>-<topic>.md`: the technical record. Context,
   decision, diagram, consequences, alternatives, verification. Use
   `docs/adr/TEMPLATE.md`.
2. `docs/adr/ADR-<YYYY-MM-DD>-<topic>-for-dummies.md`: the same decision in
   plain English for someone who will not read code. Use
   `docs/adr/TEMPLATE-for-dummies.md`.

Rules:

- Both open as `Proposed, awaiting maintainer approval`.
- An agent never approves its own ADR or plan.
- Work does not start until the maintainer approves both records in so many
  words, for example "I approve ADR-2026-10-29-ai-governance". Silence is not
  approval. A question about the ADR is not approval.
- After approval, both records flip to `Accepted <date>` in the same pull
  request as the implementation.

Trivial work skips this step: a typo, a copy change, a one-line fix with a
regression test. When unsure, it is not trivial.

### Directive 3: Red, then green

For every bug, regression, or security defect:

1. Red: write a test that reproduces the defect. Run it and confirm it fails
   for the reason the bug exists, not because of a typo or a missing import.
2. Green: make the smallest production change that passes it. Re-run the full
   suite.

The test stays in the codebase as the regression lock.

### Directive 4: No masking

Never make a gate pass by hiding the problem:

- No empty `catch` blocks, and no `catch` that turns a failure into a success.
- No `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error` without a linked issue,
  and no `any`. Biome rejects explicit `any` across the repository.
- No dummy, empty, or fallback values that hide a missing upstream.
- No deleting, skipping, or weakening a failing assertion.
- No raising a timeout, a threshold, or a TTL to make a test pass.
- No `biome-ignore` comment without a reason that names the rule and why the
  code is correct.

### Directive 5: Preflight must pass

Before opening a pull request or calling a task done, run:

```bash
./scripts/preflight.sh
```

It runs five gates in order: format check, lint (warnings fail), typecheck,
tests, production build. All five must pass in one run. A gate that passes
only when run alone does not count.

---

## Lifecycle

```text
0 SYNC -> 1 DECIDE -> 2 PLAN -> 3 ISOLATE -> 4 BUILD -> 5 VERIFY -> 6 DOCUMENT -> 7 DELIVER
```

0. **Sync.** `git fetch origin main`. Read the issue, the code it touches, and
   `docs/design.md`.
1. **Decide.** Non-trivial work gets the two ADRs (Directive 2). Stop and wait
   for approval.
2. **Plan.** `docs/plans/<YYYY-MM-DD>-<topic>-plan.md` from
   `docs/plans/TEMPLATE.md`: boundaries, interfaces, the failing tests to write
   first, and ordered steps.
3. **Isolate.** Create the worktree (Directive 1).
4. **Build.** Test first, inside the layering rules in SKILL.md.
5. **Verify.** `./scripts/preflight.sh`, then run the affected flow by hand.
   For the payment path that means at least `MOCK_MODE=true pnpm --filter
   @tollway/demo start`.
6. **Document.** A release note in `docs/release-notes/<YYYY-MM-DD>-<topic>.md`
   from `docs/release-notes/TEMPLATE.md`. If a publishable package changed, a
   changeset too (`pnpm changeset`). The release note is the human summary;
   the changeset is the version bump. A change to `packages/*/src` needs both.
7. **Deliver.** Open the pull request against `main` with
   `.github/pull_request_template.md`. Every CI job, and the aggregate
   `quality` check, must be green before review.

---

## Gates and where they run

| Where | What runs | Cost |
| ----- | --------- | ---- |
| pre-commit (lefthook) | `biome check --write` on staged files, fixes re-staged | seconds |
| pre-push (lefthook) | `./scripts/preflight.sh --fast` (everything except the build) | about a minute |
| CI `checks` | `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | |
| CI `tests` | `pnpm test` | |
| CI `build` | `pnpm build`, then `scripts/check_release_notes.sh` in strict mode | |
| CI `quality` | fails unless every job above succeeded | the required check |

Hooks are installed by `pnpm install` (lefthook's postinstall, allowed in
`pnpm-workspace.yaml`). If a hook is skipped with `LEFTHOOK=0`, say so in the
pull request and why.

---

## Reviewing contributor pull requests

Some pull requests are written to attack the maintainer rather than to improve
the project: code that steals SSH keys, registry tokens or wallet keys the
moment someone installs or builds it. The `security` check
(`.github/workflows/pr-security.yml`, decided in
`docs/adr/ADR-2026-10-29-pr-security-gate.md`) blocks the known patterns. These
rules cover what a scanner cannot:

- Never check out, install, build or test a contributor's branch on a personal
  machine before `security` is green. Read the diff on GitHub first.
- When a local run is needed, install without lifecycle scripts and without Git
  hooks: `LEFTHOOK=0 pnpm install --frozen-lockfile --ignore-scripts`. A contributor's branch can change `lefthook.yml`,
  `package.json` scripts and every script the hooks call.
- A change to a sensitive path (listed in
  `.github/security/sensitive-paths.txt`) needs a maintainer to read every
  changed line of those files, then approve the pull request on GitHub. The
  approval counts only for the commit it was given on; a later push needs a new
  review.
- Never add a `zizmor: ignore` comment, a Semgrep exclusion, a binary allowlist
  entry or a Knip `ignoreDependencies` entry to make a contributor's pull
  request pass. Fix the finding, or narrow the rule with a test case in a
  maintainer's own pull request.
- Agents follow the same rules and never approve a pull request.

## Pre-review defect checklist

Check every item before asking for review. SKILL.md explains each one.

1. **Boundary validation.** Every external payload (x402 and MPP headers,
   facilitator responses, webhook bodies, cache entries read from a shared
   store) is parsed with a schema at the boundary and mapped to a Tollway type.
   Raw upstream JSON never travels further in.
2. **Integer base units.** Amounts are integer strings in the asset's smallest
   unit, compared and summed as `bigint`. No `number`, no floats, no
   `parseFloat`. Stellar USDC has 7 decimals.
3. **Receipts bound to the offer.** A receipt, fresh or cached, is only
   returned for the offer it was issued against: same `resource`, `amount`,
   `asset`, `payee`, `network`, and `model`.
4. **Replay and idempotency.** A payment is settled at most once. The
   idempotency key is derived from the signed payment, the lookup happens
   before settlement, and concurrent duplicates cannot both reach `/settle`.
5. **Awaited writes.** Every promise is awaited or returned, including cache
   writes and webhook sends. No floating promise on the payment path.
6. **Webhook signing.** Outbound webhooks are signed and receivers can verify
   them. Tests cover a forged and a replayed delivery.
7. **Adapter conformance.** A gate behaviour change is exercised through all
   four adapters (Express, Fastify, Next, Hono), including the error path.
8. **No invented protocol surface.** x402 and MPP calls match the installed
   `@x402/*` and `@stellar/mpp` versions. Read the package source or current
   docs, never memory.
9. **No custody.** Nothing makes Tollway hold, route, or escrow funds.
10. **Changeset.** A change to a publishable package under `packages/` ships a
    changeset. Private apps (`dashboard`, `demo`, `web`) do not.
11. **Release note.** Package or app source changed, so
    `docs/release-notes/` has an entry.
12. **Preflight.** `./scripts/preflight.sh` passed in full.

---

## Git and pull requests

- One issue, one branch, one pull request. Prefixes: `feat/`, `fix/`,
  `chore/`, `docs/`, `test/`.
- Conventional Commits, for example
  `fix(server): bind cached receipts to the offer`.
- Squash merges only. The branch is deleted on merge.
- The pull request body includes `Closes #<issue>`.
- Never add AI co-author trailers, "generated with" footers, or session links
  to commits, pull requests, or files.
- Never commit or push on a maintainer's or contributor's behalf unless asked.
- Never commit secrets. `.env*` files stay out of Git; `.env.example` is the
  only exception.
- Security defects are reported privately through
  [SECURITY.md](SECURITY.md), never in a public issue or pull request.
