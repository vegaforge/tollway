import { type NextRequest, NextResponse } from "next/server";
import { activeSession } from "@/lib/authorize";

/**
 * First line of the dashboard's access control: no session, no page and no
 * API. Every route handler and server component checks again for itself
 * (src/lib/authorize.ts), so this is an early refusal, not the only one.
 * Next.js 16 runs proxy.ts on the Node.js runtime, in the same process as
 * the route handlers, which is why it can consult the revocation store.
 */
export async function proxy(request: NextRequest) {
  if (await activeSession(request)) {
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
  // Everything except the sign-in page, the sign-in endpoint, and static
  // assets. Each exclusion is anchored so `/login-anything` or
  // `/api/auth/login/x` is still protected.
  matcher: ["/((?!api/auth/login$|login$|_next/static/|_next/image|favicon\\.ico$).*)"],
};
