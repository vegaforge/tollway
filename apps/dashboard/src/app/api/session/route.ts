import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/authorize";
import { csrfToken } from "@/lib/csrf";

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authorizeRequest(request, "viewer");
  if (!auth.ok) return auth.response;

  const { session } = auth;
  return NextResponse.json(
    { username: session.username, role: session.role, csrfToken: csrfToken(session.sid) },
    // The body carries the CSRF token, so no shared cache may keep it.
    { headers: { "cache-control": "no-store" } },
  );
}
