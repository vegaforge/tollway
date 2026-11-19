import { jwtVerify, SignJWT } from "jose";

export type Role = "viewer" | "admin";

export type Session = {
  sid: string;
  username: string;
  role: Role;
  exp: number;
};

export const COOKIE_NAME = "tollway_dashboard_session";

export function getSessionSecret(): Uint8Array {
  const value = process.env.DASHBOARD_SESSION_SECRET;
  if (!value) {
    throw new Error("DASHBOARD_SESSION_SECRET is not configured");
  }
  return Buffer.from(value, "utf8");
}

export async function createSessionToken(session: Session): Promise<string> {
  return new SignJWT({
    sid: session.sid,
    username: session.username,
    role: session.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(session.exp)
    .sign(getSessionSecret());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    if (
      typeof payload.sid !== "string" ||
      typeof payload.username !== "string" ||
      (payload.role !== "viewer" && payload.role !== "admin") ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      sid: payload.sid,
      username: payload.username,
      role: payload.role,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export async function readSession(request: Request): Promise<Session | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

  if (!value) {
    return null;
  }

  return verifySessionToken(decodeURIComponent(value));
}

export function requireRole(session: Session, role: Role): void {
  if (session.role !== role) {
    throw new Error("Forbidden");
  }
}
