import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/authorize";
import { revokeSession } from "@/lib/session-store";

type RouteContext = {
  params: Promise<{ sid: string }>;
};

/** Admin only: ends another session at once, for example a lost laptop. */
export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  const auth = await authorizeRequest(request, "admin", { mutation: true });
  if (!auth.ok) return auth.response;

  const { sid } = await context.params;
  if (!revokeSession(sid)) {
    return NextResponse.json({ error: "Unknown session" }, { status: 404 });
  }
  return NextResponse.json({ revoked: true });
}
