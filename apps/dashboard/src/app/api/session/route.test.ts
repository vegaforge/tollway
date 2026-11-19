import { beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME, createSessionToken, type Session } from "../../../lib/session";
import { rememberSession, resetSessionStore, revokeSession } from "../../../lib/session-store";
import { GET } from "./route";

const session: Session = {
  sid: "session-1",
  username: "viewer",
  role: "viewer",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", "test-secret");
  resetSessionStore();
});

describe("/api/session", () => {
  it("returns 401 without a valid session", async () => {
    const response = await GET(new Request("http://localhost/api/session"));

    expect(response.status).toBe(401);
  });

  it("returns identity and CSRF token for an active session", async () => {
    rememberSession(session);
    const token = await createSessionToken(session);
    const response = await GET(
      new Request("http://localhost/api/session", {
        headers: { cookie: `${COOKIE_NAME}=${token}` },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      username: "viewer",
      role: "viewer",
    });
  });

  it("returns 401 for a revoked session", async () => {
    rememberSession(session);
    const token = await createSessionToken(session);
    revokeSession(session.sid);
    const response = await GET(
      new Request("http://localhost/api/session", {
        headers: { cookie: `${COOKIE_NAME}=${token}` },
      }),
    );

    expect(response.status).toBe(401);
  });
});
