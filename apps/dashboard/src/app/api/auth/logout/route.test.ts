import { beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken } from "@/lib/csrf";
import { isActiveSession, resetSessionStore } from "@/lib/session-store";
import { session, signedInCookie, TEST_SECRET } from "@/test/auth-fixtures";
import { POST } from "./route";

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("DASHBOARD_ORIGIN", "");
  resetSessionStore();
});

function logout(cookie: string | null, token: string | null, origin = "http://localhost") {
  const headers: Record<string, string> = { origin, host: "localhost" };
  if (cookie) headers.cookie = cookie;
  if (token !== null) headers["x-csrf-token"] = token;
  return POST(new Request("http://localhost/api/auth/logout", { method: "POST", headers }));
}

describe("/api/auth/logout", () => {
  it("revokes the session server side and clears the cookie", async () => {
    const value = session();
    const cookie = await signedInCookie(value);

    const response = await logout(cookie, csrfToken(value.sid));

    expect(response.status).toBe(200);
    expect(isActiveSession(value)).toBe(false);
    expect(response.headers.get("set-cookie") ?? "").toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("returns 401 without a session", async () => {
    expect((await logout(null, "anything")).status).toBe(401);
  });

  it("rejects a missing or wrong CSRF token and keeps the session", async () => {
    const value = session();
    const cookie = await signedInCookie(value);

    expect((await logout(cookie, null)).status).toBe(403);
    expect((await logout(cookie, csrfToken("someone-else"))).status).toBe(403);
    expect(isActiveSession(value)).toBe(true);
  });

  it("rejects a cross-origin request carrying a valid token", async () => {
    const value = session();
    const cookie = await signedInCookie(value);

    expect((await logout(cookie, csrfToken(value.sid), "http://attacker.test")).status).toBe(403);
    expect(isActiveSession(value)).toBe(true);
  });
});
