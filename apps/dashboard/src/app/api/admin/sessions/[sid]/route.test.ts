import { beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken } from "../../../../../lib/csrf";
import { COOKIE_NAME, createSessionToken, type Session } from "../../../../../lib/session";
import { rememberSession, resetSessionStore } from "../../../../../lib/session-store";
import { DELETE } from "./route";

const admin: Session = {
  sid: "admin-session",
  username: "admin",
  role: "admin",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", "test-secret");
  resetSessionStore();
});

async function request(session: Session | null) {
  const token = session ? await createSessionToken(session) : "invalid";
  return new Request("http://localhost/api/admin/sessions/target-session", {
    method: "DELETE",
    headers: {
      cookie: `${COOKIE_NAME}=${token}`,
      "x-csrf-token": session ? csrfToken(session.sid) : "invalid",
      origin: "http://localhost",
      host: "localhost",
    },
  });
}

describe("/api/admin/sessions/[sid]", () => {
  it("returns 401 without an authenticated session", async () => {
    const response = await DELETE(await request(null), {
      params: Promise.resolve({ sid: "target-session" }),
    });

    expect(response.status).toBe(401);
  });

  it("returns 403 for a viewer", async () => {
    rememberSession(admin);
    const viewer = { ...admin, sid: "viewer-session", role: "viewer" as const };
    rememberSession(viewer);
    const response = await DELETE(await request(viewer), {
      params: Promise.resolve({ sid: "target-session" }),
    });

    expect(response.status).toBe(403);
  });

  it("revokes a session for an admin", async () => {
    rememberSession(admin);
    const response = await DELETE(await request(admin), {
      params: Promise.resolve({ sid: "target-session" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
  });
});
