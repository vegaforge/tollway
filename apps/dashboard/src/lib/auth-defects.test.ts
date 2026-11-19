import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { proxy } from "@/proxy";
import { TEST_SECRET, usersJson } from "@/test/auth-fixtures";
import { resetRateLimit } from "./rate-limit";
import { COOKIE_NAME, createSessionToken, requireRole, type Session } from "./session";
import { rememberSession, resetSessionStore, revokeSession } from "./session-store";

const viewer: Session = {
  sid: "viewer-session",
  username: "viewer",
  role: "viewer",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("DASHBOARD_USERS", usersJson);
  vi.stubEnv("DASHBOARD_ORIGIN", "");
  resetSessionStore();
  resetRateLimit();
});

function loginRequest(username: string, password: string, forwardedFor: string) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      "x-forwarded-for": forwardedFor,
    },
    body: JSON.stringify({ username, password }),
  });
}

/**
 * Regression locks for the defects found reviewing the first version of
 * dashboard sign-in. Each test failed against that version.
 */
describe("defects found in review", () => {
  it("proxy rejects a session that was revoked at logout", async () => {
    rememberSession(viewer);
    const token = await createSessionToken(viewer);
    revokeSession(viewer.sid);

    const response = await proxy(
      new NextRequest("http://localhost/receipts", {
        headers: { cookie: `${COOKIE_NAME}=${token}` },
      }),
    );

    expect(response.headers.get("location")).toContain("/login");
  });

  it("does not reset the rate limit when the client changes X-Forwarded-For", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(loginRequest("viewer", "wrong", `203.0.113.${attempt}`));
    }

    const response = await login(
      loginRequest("viewer", "correct horse battery staple", "203.0.113.99"),
    );
    expect(response.status).toBe(429);
  });

  it("marks the session cookie Secure outside production too", async () => {
    const response = await login(
      loginRequest("viewer", "correct horse battery staple", "203.0.113.1"),
    );

    expect(response.headers.get("set-cookie") ?? "").toMatch(/;\s*Secure/i);
  });

  it("lets an admin through a route that needs a viewer", () => {
    expect(() => requireRole({ ...viewer, role: "admin" }, "viewer")).not.toThrow();
  });

  it("refuses a session secret shorter than 32 bytes", async () => {
    vi.stubEnv("DASHBOARD_SESSION_SECRET", "short");
    await expect(createSessionToken(viewer)).rejects.toThrow(/32/);
  });
});

describe("proxy", () => {
  it("lets a live session through and answers API calls without one with 401", async () => {
    const { signedInCookie, session } = await import("@/test/auth-fixtures");
    const cookie = await signedInCookie(session());

    const allowed = await proxy(
      new NextRequest("http://localhost/receipts", { headers: { cookie } }),
    );
    expect(allowed.headers.get("x-middleware-next")).toBe("1");

    const api = await proxy(new NextRequest("http://localhost/api/session"));
    expect(api.status).toBe(401);
  });

  it("redirects a signed-out page request to login, keeping the path", async () => {
    const response = await proxy(new NextRequest("http://localhost/agents?sort=asc"));

    expect(response.headers.get("location")).toBe(
      "http://localhost/login?next=%2Fagents%3Fsort%3Dasc",
    );
  });
});
