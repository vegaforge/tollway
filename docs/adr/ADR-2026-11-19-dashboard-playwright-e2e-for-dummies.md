# ADR for Dummies: Dashboard Playwright end-to-end and accessibility suite

- **Status:** Proposed, awaiting maintainer approval
- **Date:** 2026-11-19
- **Technical ADR:** [ADR-2026-11-19-dashboard-playwright-e2e](ADR-2026-11-19-dashboard-playwright-e2e.md)

## The idea

Test the dashboard in a real browser, not just in a pretend browser inside unit tests. The new suite opens every page from the sidebar, checks that people can use it with a keyboard, scans it for accessibility problems, and repeats the scan in light and dark themes. CI runs it only when dashboard code changes.

## What people see

1. A contributor runs one command. It builds the production dashboard, starts it on a local port, and opens a browser.
2. The suite walks through the sidebar, one page at a time. It checks that the page heading appears and that the browser reports no errors.
3. It clicks the sorting control on the Agents page, selects a receipt and sees "Signature valid", follows a channel link, and checks that a theme choice survives a reload.
4. It tabs through the app, checks that focus is visible, uses a skip link to reach the main content, and selects a receipt row with the keyboard.
5. It runs an accessibility scanner on every page in both themes. Serious and critical findings fail the suite. Real findings are fixed in the app rather than hidden.
6. A separate mobile-size browser checks the topbar and navigation.
7. On a pull request that touches the dashboard, CI runs the suite and attaches traces and screenshots if anything fails. A pull request that does not touch the dashboard reports success quickly.

## Important limitation

The suite uses the dashboard's fixed example data for now, because the real service connection has not landed. It does not test live payment data, and there is no login flow yet because authentication has not landed. Adding Playwright, a config file, and a CI job touches files the repository treats as sensitive, so a maintainer must review and approve the latest commit. The browser suite also takes longer than the existing unit tests, so it stays outside normal `pnpm test` and preflight.

## What changes

- Two new development dependencies: Playwright and the axe accessibility scanner.
- A `test:e2e` command and a Playwright config in the dashboard app.
- Browser tests for routes, common flows, keyboard use, mobile layout, and accessibility.
- A heading test hook, a skip link, and a real keyboard-operable control on receipt rows.
- A CI job that runs the suite for dashboard changes and is included in the required `quality` check.
- A short testing section in the dashboard data contract document and a release note.

## What does not change

- The existing unit tests and preflight stay as they are and keep running fast.
- No payment logic, service code, or publishable package source changes.
- No changeset is needed because the dashboard is a private app.
- No live service or real API key is used by the suite.
- No accessibility rule is switched off to make the suite pass.
