import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionStore, revokeSession } from "@/lib/session-store";
import { session, signedInCookie, TEST_SECRET } from "@/test/auth-fixtures";
import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", TEST_SECRET);
  resetSessionStore();
});

function get(cookie?: string) {
  return GET(
    new Request("http://localhost/api/session", { headers: cookie ? { cookie } : undefined }),
  );
}

describe("/api/session", () => {
  it("returns 401 when called directly without a session", async () => {
    expect((await get()).status).toBe(401);
  });

  it("returns identity and a CSRF token for an active session, uncached", async () => {
    const response = await get(await signedInCookie(session()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ username: "viewer", role: "viewer" });
  });

  it("returns 401 for a revoked session", async () => {
    const cookie = await signedInCookie(session());
    revokeSession("session-1");

    expect((await get(cookie)).status).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const cookie = await signedInCookie(session({ exp: Math.floor(Date.now() / 1000) - 5 }));

    expect((await get(cookie)).status).toBe(401);
  });

  it("returns 401 for a valid token the server never issued", async () => {
    const { createSessionToken, COOKIE_NAME } = await import("@/lib/session");
    const token = await createSessionToken(session({ sid: "never-issued" }));

    expect((await get(`${COOKIE_NAME}=${token}`)).status).toBe(401);
  });
});
