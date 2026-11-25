---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-service": patch
---

Add weekly, monthly and rolling budgets, and an IANA `timezone` and `weekStartsOn` for calendar budgets (#198). Spend is kept per period id, so a 23 or 25 hour day around a Daylight Saving Time change is one period and a clock that steps backwards never reopens a closed period. New trace rule ids `budget-weekly`, `budget-monthly` and `budget-rolling`, and new window kinds `calendar-day`, `calendar-week` and `calendar-month`. A policy without the new fields behaves as before. The service's policy request and response schemas accept the same new fields.
