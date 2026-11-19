# ADR for Dummies: Rules that fit an open-source project

- **Status:** Accepted 2026-11-19
- **Date:** 2026-11-19
- **Technical ADR:** [ADR-2026-11-19-open-source-governance](ADR-2026-11-19-open-source-governance.md)

## The idea

Tollway's rules were written for AI assistants working for the maintainer.
Now strangers are picking up issues for the Drips Wave, and some rules get in
their way without making anything safer. This keeps every safety check, but
makes good contributions pass on their own and tells contributors early, in
plain words, when something is wrong.

## What people see

1. A contributor takes an issue and starts coding straight away. The issue is
   the agreed design, so no paperwork first. If they want to do it
   differently, they ask in the issue.
2. They open one pull request for that one issue. If they bundle several
   issues, or were never assigned, a check tells them within minutes.
3. The automatic tests start on their own; the maintainer no longer has to
   click to let them run (except for brand-new GitHub accounts).
4. If they touched a file that can run code, a check says "waiting for the
   maintainer to review, nothing for you to fix" instead of a scary red error.

## Important limitation

The security scans and the maintainer's review of risky files stay exactly as
strict as today. Only the paperwork and the confusing messages go.

## What changes

- No design paperwork for contributors; only the maintainer approves designs.
- One early check for "one issue, assigned to you, no self-approved designs".
- Clearer wording on the review-needed check.
- Tests run without a click for established accounts.
- The security check takes about a minute instead of five, and approving a
  pull request no longer leaves a false red mark behind.
- The 96 issues that asked for paperwork are updated.

## What does not change

- The security scans, the branch rules, who can merge, and the rule that
  nothing merges while a check is red.
