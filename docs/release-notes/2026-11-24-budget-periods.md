---
date: 2026-11-24
feature: Rolling, calendar-day, weekly and monthly budgets with time zones
scope: feat
packages: [@vegaforge/tollway-core]
scenario-impact: none
---

# Budget periods with time zones

A policy can now budget per local business day, per week or per month, and
over a rolling window that cannot be gamed at midnight (#198). Until now the
only periodic budget was a UTC day, which an agent could spend in full at
23:59 and again at 00:01, and which reset mid-afternoon for a team west of
UTC.

```ts
budgets: {
  timezone: "America/New_York",
  weekStartsOn: "monday",
  daily: "50000000",
  weekly: "200000000",
  monthly: "500000000",
  rolling: { windowSeconds: 86_400, cap: "50000000" },
}
```

`timezone` is an IANA zone name and defaults to `UTC`, so an existing policy
with only `daily` keeps its per-UTC-day budget. Each budget is its own rule in
the decision trace (`budget-daily`, `budget-weekly`, `budget-monthly`,
`budget-rolling`), and `headroom()` and channel-open checks include them.

Technical shape: local dates come from `Intl.DateTimeFormat`, so no date
library was added to `@vegaforge/tollway-core`. Spend is stored per period id
(`day:2026-11-18@America/Los_Angeles`, `week:2026-11-16@UTC`,
`month:2026-11@Europe/London`) instead of being cleared at a boundary. A 23
or 25 hour day around a Daylight Saving Time change counts as one period. The
current period only moves forward, so a clock that steps backwards cannot
reopen a spent budget or count a payment twice. The rolling budget reuses the
bounded `RollingSum` accumulator from #192. Documentation:
`apps/web/src/content/docs/policy.mdx`, "What each field does".

Spend is still checked against settled payments: two payments admitted at the
same moment can both pass a budget before either is recorded, as with the
daily budget before this change.
