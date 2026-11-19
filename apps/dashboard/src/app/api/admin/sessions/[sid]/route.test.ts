import { beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken } from "@/lib/csrf";
import { isActiveSession, resetSessionStore } from "@/lib/session-store";
import { session, signedInCookie, TEST_SECRET } from "@/test/auth-fixtures";
import { DELETE } from "./route";

const admin = session({ sid: "admin-session", username: "admin", role: "admin" });
const viewer = session({ sid: "viewer-session" });
const target = session({ sid: "target-session", username: "someone" });

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("DASHBOARD_ORIGIN", "");
  resetSessionStore();
});

async function revoke(caller: typeof admin | null, sid: string, token?: string) {
  const headers: Record<string, string> = { origin: "http://localhost", host: "localhost" };
  if (caller) {
    headers.cookie = await signedInCookie(caller);
    headers["x-csrf-token"] = token ?? csrfToken(caller.sid);
  }
  return DELETE(
    new Request(`http://localhost/api/admin/sessions/${sid}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ sid }) },
  );
}

describe("/api/admin/sessions/[sid]", () => {
  it("returns 401 when called directly without a session", async () => {
    expect((await revoke(null, "target-session")).status).toBe(401);
  });

  it("returns 403 for a viewer and leaves the target alive", async () => {
    await signedInCookie(target);

    expect((await revoke(viewer, "target-session")).status).toBe(403);
    expect(isActiveSession(target)).toBe(true);
  });

  it("returns 403 for an admin without the CSRF token", async () => {
    await signedInCookie(target);

    expect((await revoke(admin, "target-session", "forged")).status).toBe(403);
    expect(isActiveSession(target)).toBe(true);
  });

  it("revokes a session for an admin", async () => {
    await signedInCookie(target);
    const response = await revoke(admin, "target-session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    expect(isActiveSession(target)).toBe(false);
  });

  it("returns 404 for an unknown session id", async () => {
    expect((await revoke(admin, "missing")).status).toBe(404);
  });
});
