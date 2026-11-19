---
date: 2026-11-19
feature: Dashboard sign-in, roles, and revocable sessions
scope: feat
packages: []
scenario-impact: none
---

# Dashboard authentication

The dashboard now requires sign-in. A signed-out page request goes to `/login` and returns to the page after sign-in; a signed-out API call gets 401. Users are `viewer` (read) or `admin` (read plus actions; today, revoking a session). The topbar shows who is signed in and a sign-out control, and small screens get a navigation menu.

Operators configure users in `DASHBOARD_USERS` with bcrypt hashes of cost 10 or more, and a session secret of at least 32 bytes in `DASHBOARD_SESSION_SECRET`; the identity provider is selectable with `DASHBOARD_AUTH_PROVIDER`. A session is an 8-hour `HttpOnly`, `Secure`, `SameSite=Lax` cookie backed by a server-side store, so logging out or an admin revocation ends it at once, in `proxy.ts` as well as in every handler. Each route handler, server component and server action checks the session and role itself; state changes also need a same-origin request and a session-bound CSRF token. Failed sign-ins are throttled per username, per trusted client address and in total, and an unknown username is indistinguishable from a wrong password, including in timing. The store and throttle are in memory, so run one dashboard process. The service API key never reaches the browser. See the [dashboard data contracts](../dashboard-data-contracts.md), "Dashboard security", and [ADR-2026-11-19-dashboard-authentication](../adr/ADR-2026-11-19-dashboard-authentication.md) (proposed).
