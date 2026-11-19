---
date: 2026-11-19
feature: Dashboard browser and accessibility suite
scope: chore
packages: []
scenario-impact: none
---

# Dashboard browser tests

The dashboard now has a Playwright suite that opens every navigation route in light, dark, and mobile Chromium projects, signs in and out, checks keyboard operation, and runs axe against serious and critical accessibility violations. CI runs it in the `e2e` job and gates `quality`; pull requests that do not touch the dashboard, lockfile, or workflow report success without a browser run.

Three real defects surfaced during the red run and are fixed here: pages now expose a stable `page-header` hook, the shell has a skip link to `<main id="main-content">`, and receipt rows have a focusable select button. Low-contrast login and status pills and a non-focusable scrolling channels table were also corrected rather than hidden with axe rule exclusions. See [ADR-2026-11-19-dashboard-playwright-e2e](../adr/ADR-2026-11-19-dashboard-playwright-e2e.md) and the [dashboard data contracts](../dashboard-data-contracts.md) for how to run and extend the suite.
