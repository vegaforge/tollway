---
date: 2026-11-19
feature: Dashboard browser and accessibility suite
scope: chore
packages: []
scenario-impact: none
---

# Dashboard browser tests

The dashboard has a Playwright suite that drives the production build in light, dark and mobile Chromium projects: every navigation route loads with its header and is reachable from the navigation; the main flows work (sorting agents, a valid receipt signature, the channel link from a receipt, the theme surviving a reload); sign-in, sign-out and the security refusals behave; the app works by keyboard, with a skip link and visible focus; the mobile menu works; and axe finds no serious or critical violation on any route. Every test also fails on a console error. CI runs it in the `dashboard e2e` job, part of `quality`, whenever the dashboard or what it builds from changes.

Defects the suite found are fixed in the components rather than excluded: a skip link and focusable `<main>`, a keyboard-operable receipt select button whose accessible name includes its visible text, a navigation menu for small screens (the sidebar was the only navigation), visible focus on the sort control, and higher-contrast status pills. Run it with `pnpm --filter @vegaforge/tollway-dashboard test:e2e`; see the [dashboard data contracts](../dashboard-data-contracts.md), "End-to-end tests", and [ADR-2026-11-19-dashboard-playwright-e2e](../adr/ADR-2026-11-19-dashboard-playwright-e2e.md) (proposed).
