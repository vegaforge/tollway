import { NextResponse } from "next/server";
import { isSameOrigin, isValidCsrf } from "../../../../../lib/csrf";
import { readSession, requireRole } from "../../../../../lib/session";
import { isActiveSession, revokeSession } from "../../../../../lib/session-store";

type RouteContext = {
  params: Promise<{ sid: string }>;
};

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  const session = await readSession(request);
  if (!session || !isActiveSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    requireRole(session, "admin");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const token = request.headers.get("x-csrf-token") ?? "";
  if (!isSameOrigin(request) || !isValidCsrf(session.sid, token)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { sid } = await context.params;
  revokeSession(sid);
  return NextResponse.json({ revoked: true });
}
