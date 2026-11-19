---
date: 2026-11-19
feature: Dashboard sign-in, roles, and revocable sessions
scope: feat
packages: []
scenario-impact: none
---

# Dashboard authentication

Dashboard pages now require sign-in. Signed-out page requests go to `/login?next=<path>`, and signed-out API calls receive JSON 401. A viewer can read the dashboard; an admin can also revoke another session through `DELETE /api/admin/sessions/[sid]`. The shell shows the signed-in identity and a sign-out control.

The dashboard signs users with `DASHBOARD_USERS` and `DASHBOARD_SESSION_SECRET`, verifies bcrypt hashes server side, and issues an eight-hour HS256 cookie named `tollway_dashboard_session`. `proxy.ts` performs the optimistic redirect, while each route handler re-checks the session and role. State-changing handlers check origin and a session-bound CSRF token. Failed logins are uniform and rate-limited per username and client address. Session revocation and rate-limit counters live in memory, so a restart clears them and a multi-instance deployment needs a shared store before production use. The service API key remains server side. See [ADR-2026-11-19-dashboard-authentication](../adr/ADR-2026-11-19-dashboard-authentication.md).
