import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { csrfToken, isSameOrigin } from "@/lib/csrf";
import { loadIdentityProvider } from "@/lib/identity";
import { isRateLimited, recordFailure, trustedClientAddress } from "@/lib/rate-limit";
import {
  createSessionToken,
  SESSION_TTL_SECONDS,
  type Session,
  sessionCookieOptions,
} from "@/lib/session";
import { rememberSession } from "@/lib/session-store";

// Bounds the work one request can ask for. bcrypt only reads the first 72
// bytes of a password, but the string is still encoded in full.
const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 1024;

type Credentials = { username: string; password: string };

function parseCredentials(body: unknown): Credentials | null {
  if (typeof body !== "object" || body === null) return null;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  if (username.length === 0 || username.length > MAX_USERNAME_LENGTH) return null;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return null;
  return { username, password };
}

export async function POST(request: Request): Promise<NextResponse> {
  // Login CSRF: a cross-site page must not sign the victim in as the attacker.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // A body that is not JSON is a malformed request, answered as one.
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const credentials = parseCredentials(body);
  if (credentials === null) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const subject = { username: credentials.username, client: trustedClientAddress(request) };
  if (isRateLimited(subject)) {
    return NextResponse.json(
      { error: "Too many attempts" },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const user = await loadIdentityProvider().authenticate(
    credentials.username,
    credentials.password,
  );
  if (user === null) {
    recordFailure(subject);
    // One message for an unknown user and a wrong password.
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const session: Session = {
    sid: randomUUID(),
    username: user.username,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  rememberSession(session);

  const response = NextResponse.json({
    username: session.username,
    role: session.role,
    csrfToken: csrfToken(session.sid),
  });
  response.cookies.set({
    ...sessionCookieOptions(new Date(session.exp * 1000)),
    value: await createSessionToken(session),
  });
  return response;
}
