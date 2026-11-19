# Plan: Dashboard authentication and browser suite (2026-11-19)

- **ADR:** [ADR-2026-11-19-dashboard-authentication](../adr/ADR-2026-11-19-dashboard-authentication.md), [ADR-2026-11-19-dashboard-playwright-e2e](../adr/ADR-2026-11-19-dashboard-playwright-e2e.md)
- **Issue:** #239, #240

## Boundaries

`apps/dashboard` receives a `proxy.ts`, server-only auth and session modules, a login page, route handlers, shell changes, Vitest tests, Playwright config and tests, docs, and a release note. `apps/dashboard/package.json` and `pnpm-lock.yaml` gain two runtime and two dev dependencies. `.github/workflows/ci.yml` gains one e2e job added to `quality.needs`. No `packages/*` source changes, so no changeset. #241 stays unimplemented and unclosed because #193 and #228 are open.

## Interfaces

- `src/lib/session.ts`: `Session`, `role`, `createSessionToken`, `verifySessionToken`, `readSession`, and `requireRole`.
- `src/lib/session-store.ts`: `rememberSession`, `isActiveSession`, `revokeSession`, and `resetSessionStore`.
- `src/lib/csrf.ts` and `src/lib/rate-limit.ts`: origin/token checks and failed-login counters.
- `src/lib/users.ts`: reads `DASHBOARD_USERS` and verifies a password with `bcryptjs`.
- `proxy.ts`: named `proxy(request)` plus a static `config.matcher` that excludes `/login` and static assets, and returns 401 for `/api/**`.
- Route handlers: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/session`, `DELETE /api/admin/sessions/[sid]`.
- `playwright.config.ts`: three Chromium projects, `webServer` on a fixed port, trace and screenshot on failure.
- `e2e/routes.spec.ts`, `e2e/flows.spec.ts`, `e2e/accessibility.spec.ts`, `e2e/keyboard.spec.ts`.

## State changes

Sessions live in a server-side in-memory map keyed by session id and record expiry and revocation. Login rate-limit counters live in memory per username and client address. No persisted database, no service API key in browser code, and no new environment file beyond `.env.example`.

## Test strategy

Red first against the current app: signed-out page requests do not redirect, `/api/session` does not return 401, a viewer reaches the admin handler, expired and revoked tokens pass, CSRF and rate limits are absent, receipt rows cannot be selected by keyboard, there is no skip link, and there is no `test:e2e` script or Playwright config. Keep each failing test as the regression lock. Then make the smallest production change that passes them.

## Steps

1. Write the auth and e2e red tests, run them, and confirm each fails for the missing behaviour.
2. Add `jose`, `bcryptjs`, `@playwright/test`, and `@axe-core/playwright`, then verify APIs against installed source.
3. Implement server-only users, session store, and auth helpers with uniform login failures and rate limiting.
4. Add `proxy.ts`, the login page, and the four route handlers with authoritative role and CSRF checks.
5. Add the shell identity and logout control, the header test hook, the skip link, and the keyboard-operable receipt control.
6. Add the Playwright config and route, flow, axe, and keyboard tests using imported `navItems`.
7. Add the dashboard e2e CI job and include it in `quality.needs`.
8. Update `docs/dashboard-data-contracts.md`, `docs/design.md` security notes, and add release notes.
9. Run `./scripts/preflight.sh` and `pnpm --filter @vegaforge/tollway-dashboard test:e2e` in one verification pass.
