import bcrypt from "bcryptjs";
import { COOKIE_NAME, createSessionToken, type Session } from "@/lib/session";
import { rememberSession } from "@/lib/session-store";

/** Shared setup for the server-side auth tests. */

export const TEST_SECRET = "a-test-secret-that-is-at-least-32-bytes-long";
export const VIEWER_PASSWORD = "correct horse battery staple";
export const ADMIN_PASSWORD = "admin battery staple horse";

// Cost 10 is the minimum identity.ts accepts. Hashed once per test file.
export const viewerHash = bcrypt.hashSync(VIEWER_PASSWORD, 10);
export const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);

export const usersJson = JSON.stringify([
  { username: "viewer", passwordHash: viewerHash, role: "viewer" },
  { username: "admin", passwordHash: adminHash, role: "admin" },
]);

export function session(overrides: Partial<Session> = {}): Session {
  return {
    sid: "session-1",
    username: "viewer",
    role: "viewer",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

/** Issues a session the way login does and returns its Cookie header. */
export async function signedInCookie(value: Session): Promise<string> {
  rememberSession(value);
  return `${COOKIE_NAME}=${await createSessionToken(value)}`;
}
