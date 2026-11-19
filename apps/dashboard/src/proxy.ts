import { type NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/session";

export async function proxy(request: NextRequest) {
  const session = await readSession(request);
  if (session) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!api/auth/login|login|_next/static|_next/image|favicon.ico).*)"],
};
