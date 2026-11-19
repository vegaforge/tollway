import { NextResponse } from "next/server";
import { csrfToken, isSameOrigin } from "../../../../lib/csrf";
import { COOKIE_NAME, readSession } from "../../../../lib/session";
import { revokeSession } from "../../../../lib/session-store";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const session = await readSession(request);
  const token = request.headers.get("x-csrf-token") ?? "";
  if (!session || token !== csrfToken(session.sid)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  revokeSession(session.sid);
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
  return response;
}
