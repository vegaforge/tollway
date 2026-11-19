import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/authorize";
import { sessionCookieOptions } from "@/lib/session";
import { revokeSession } from "@/lib/session-store";

export async function POST(request: Request): Promise<NextResponse> {
  // Logout changes state, so it needs the CSRF token: otherwise any site
  // could sign the user out.
  const auth = await authorizeRequest(request, "viewer", { mutation: true });
  if (!auth.ok) return auth.response;

  revokeSession(auth.session.sid);
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set({ ...sessionCookieOptions(new Date(0)), value: "" });
  return response;
}
