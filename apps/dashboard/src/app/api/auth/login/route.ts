import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { csrfToken, isSameOrigin } from "../../../../lib/csrf";
import { isRateLimited, recordFailure } from "../../../../lib/rate-limit";
import { COOKIE_NAME, createSessionToken, type Session } from "../../../../lib/session";
import { rememberSession } from "../../../../lib/session-store";
import { verifyCredentials } from "../../../../lib/users";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { username?: unknown }).username !== "string" ||
    typeof (body as { password?: unknown }).password !== "string"
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { username, password } = body as { username: string; password: string };
  const client = request.headers.get("x-forwarded-for") ?? "unknown";
  const key = `${username}:${client}`;
  if (isRateLimited(key)) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const user = verifyCredentials(username, password);
  if (!user) {
    recordFailure(key);
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const session: Session = {
    sid: randomUUID(),
    username: user.username,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
  };
  rememberSession(session);

  const token = await createSessionToken(session);
  const response = NextResponse.json({
    username: session.username,
    role: session.role,
    csrfToken: csrfToken(session.sid),
  });
  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(session.exp * 1000),
  });
  return response;
}
