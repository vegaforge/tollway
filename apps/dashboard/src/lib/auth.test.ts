import { beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken, isSameOrigin, isValidCsrf } from "./csrf";
import { isRateLimited, recordFailure, resetRateLimit } from "./rate-limit";
import {
  COOKIE_NAME,
  createSessionToken,
  readSession,
  requireRole,
  type Session,
  verifySessionToken,
} from "./session";
import {
  isActiveSession,
  rememberSession,
  resetSessionStore,
  revokeSession,
} from "./session-store";

const session: Session = {
  sid: "session-1",
  username: "viewer",
  role: "viewer",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", "test-secret");
  resetSessionStore();
  resetRateLimit();
});

describe("session tokens", () => {
  it("round-trips a signed session and rejects tampering", async () => {
    const token = await createSessionToken(session);

    await expect(verifySessionToken(token)).resolves.toEqual(session);
    await expect(verifySessionToken(`${token}tampered`)).resolves.toBeNull();
  });

  it("rejects an expired session", async () => {
    const token = await createSessionToken({ ...session, exp: 1 });

    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it("reads the session cookie from a request", async () => {
    const token = await createSessionToken(session);
    const request = new Request("http://localhost/", {
      headers: { cookie: `${COOKIE_NAME}=${token}` },
    });

    await expect(readSession(request)).resolves.toEqual(session);
  });

  it("returns null when the cookie is absent", async () => {
    await expect(readSession(new Request("http://localhost/"))).resolves.toBeNull();
  });
});

describe("authorization", () => {
  it("denies a viewer an admin-only route", () => {
    expect(() => requireRole(session, "admin")).toThrow("Forbidden");
  });

  it("allows an admin an admin-only route", () => {
    expect(() => requireRole({ ...session, role: "admin" }, "admin")).not.toThrow();
  });

  it("marks revoked and expired sessions inactive", () => {
    rememberSession(session);
    expect(isActiveSession(session)).toBe(true);
    revokeSession(session.sid);
    expect(isActiveSession(session)).toBe(false);
    expect(isActiveSession({ ...session, sid: "missing" })).toBe(false);
    expect(isActiveSession({ ...session, exp: 1 })).toBe(false);
  });
});

describe("request defenses", () => {
  it("validates same-origin requests", () => {
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    });

    expect(isSameOrigin(request)).toBe(true);
    expect(
      isSameOrigin(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { origin: "http://attacker.test", host: "localhost" },
        }),
      ),
    ).toBe(false);
  });

  it("binds the CSRF token to the session", () => {
    const token = csrfToken(session.sid);

    expect(isValidCsrf(session.sid, token)).toBe(true);
    expect(isValidCsrf("other-session", token)).toBe(false);
  });

  it("rate limits repeated failures", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(isRateLimited("127.0.0.1")).toBe(false);
      recordFailure("127.0.0.1");
    }
    expect(isRateLimited("127.0.0.1")).toBe(true);
  });
});
