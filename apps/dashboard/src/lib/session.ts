import { errors, jwtVerify, SignJWT } from "jose";

/**
 * Dashboard sessions. The cookie carries a signed token so the proxy can
 * reject a forged or expired cookie without any lookup, and the token's
 * `sid` is checked against the server-side store (session-store.ts) so a
 * logged-out or revoked session stops working before it expires. See
 * docs/dashboard-data-contracts.md, "Dashboard security".
 */

export const roles = ["viewer", "admin"] as const;
export type Role = (typeof roles)[number];

export type Session = {
  sid: string;
  username: string;
  role: Role;
  /** Expiry in seconds since the epoch, the JWT `exp` claim. */
  exp: number;
};

export const COOKIE_NAME = "tollway_dashboard_session";

/** Absolute session lifetime. There is no sliding renewal: sign in again after it. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

// HS256 needs a key at least as long as its output, 32 bytes. A shorter
// secret is a configuration mistake that would make tokens guessable, so it
// is refused rather than accepted with a warning.
const MIN_SECRET_BYTES = 32;
const ALGORITHM = "HS256";
const ISSUER = "tollway-dashboard";
const AUDIENCE = "tollway-dashboard";

export function getSessionSecret(): Uint8Array {
  const value = process.env.DASHBOARD_SESSION_SECRET;
  if (!value) {
    throw new Error("DASHBOARD_SESSION_SECRET is not configured");
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new Error(`DASHBOARD_SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return bytes;
}

export async function createSessionToken(session: Session): Promise<string> {
  return new SignJWT({ sid: session.sid, username: session.username, role: session.role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(session.exp)
    .sign(getSessionSecret());
}

function isRole(value: unknown): value is Role {
  return roles.some((role) => role === value);
}

/**
 * The verified session in a token, or null when the token is malformed,
 * forged, expired, or signed for something else. Only those outcomes are
 * mapped to null; a missing or short secret still throws, so a broken
 * deployment fails loudly instead of treating everyone as signed out.
 */
export async function verifySessionToken(token: string): Promise<Session | null> {
  const secret = getSessionSecret();
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
    }));
  } catch (error) {
    // jose throws a JOSEError for every invalid token (bad signature,
    // expired, wrong claims). Each means "no session". Anything else is a
    // real fault and propagates.
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
  if (
    typeof payload.sid !== "string" ||
    typeof payload.username !== "string" ||
    !isRole(payload.role) ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  return { sid: payload.sid, username: payload.username, role: payload.role, exp: payload.exp };
}

/** The session cookie's value from a raw `Cookie` header, if present. */
export function sessionCookieValue(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      const value = trimmed.slice(COOKIE_NAME.length + 1);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** The signed session on a request. It does not consult the revocation store. */
export async function readSession(request: Request): Promise<Session | null> {
  const value = sessionCookieValue(request.headers.get("cookie"));
  return value === null ? null : verifySessionToken(value);
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, admin: 1 };

/** True when `role` grants at least what `required` grants. An admin can do what a viewer can. */
export function hasRole(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export class ForbiddenError extends Error {
  constructor(required: Role) {
    super(`Forbidden: requires the ${required} role`);
    this.name = "ForbiddenError";
  }
}

export function requireRole(session: Session, required: Role): void {
  if (!hasRole(session.role, required)) {
    throw new ForbiddenError(required);
  }
}

/** Cookie attributes shared by sign-in and sign-out, so the two never drift apart. */
export function sessionCookieOptions(expires: Date) {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    // Always Secure. Browsers treat http://localhost as a secure context, so
    // local development still works without TLS.
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}
