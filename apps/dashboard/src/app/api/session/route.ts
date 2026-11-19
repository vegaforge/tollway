import { NextResponse } from "next/server";
import { csrfToken } from "../../../lib/csrf";
import { readSession } from "../../../lib/session";
import { isActiveSession } from "../../../lib/session-store";

export async function GET(request: Request): Promise<NextResponse> {
  const session = await readSession(request);
  if (!session || !isActiveSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    username: session.username,
    role: session.role,
    csrfToken: csrfToken(session.sid),
  });
}
