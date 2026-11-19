# ADR for Dummies: Dashboard authentication with server-side sessions and roles

- **Status:** Accepted 2026-11-19
- **Date:** 2026-11-19
- **Technical ADR:** [ADR-2026-11-19-dashboard-authentication](ADR-2026-11-19-dashboard-authentication.md)

## The idea

Put a login in front of the dashboard. A lightweight check at the door sends signed-out visitors to the login page, and every page and handler checks again before it does any work. There are two kinds of users: viewers can read, and admins can also change things.

## What people see

1. Someone opens any dashboard page while signed out and lands on a login page.
2. They enter a username and password configured by the operator. Wrong usernames and wrong passwords produce the same message.
3. After login, the browser holds a cookie that the page scripts cannot read. It expires after eight hours.
4. A viewer sees read-only pages. If they try an admin action directly, the server refuses it.
5. An admin can revoke another session. Logging out revokes the current session immediately.
6. State-changing requests are checked for a valid origin and token, so another site cannot trigger them.
7. The docs explain how to configure users, how long sessions last, and that the service API key never goes to the browser.

## Important limitation

Session revocation and login rate limits live in the running dashboard process. A restart clears them, and an installation with several dashboard processes needs a shared store before production use. The service connection is still stub data because #237 has not landed. New dependencies touch sensitive files and need maintainer approval on the exact commit.

## What changes

- Two small dependencies for signed session cookies and password hashing.
- A login page, session handlers, a server-side session store, and a proxy check.
- A username and role shown in the shell with a logout control.
- Tests for redirects, 401 responses, viewer denial, expiry, revocation, CSRF, and rate limits.
- A dashboard security section and a release note.

## What does not change

- No payment logic or service API change.
- No third-party login provider is required.
- No password or real hash is committed to the repository.
- No service API key is exposed to browser code.
