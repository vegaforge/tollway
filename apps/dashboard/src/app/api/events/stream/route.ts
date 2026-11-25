/**
 * GET /api/events/stream
 *
 * Server-side proxy for the tollway-service SSE stream. The Next.js server
 * adds the service API key so it never reaches the browser. The session
 * cookie is validated here with the same `authorizeRequest` path every other
 * route handler uses; EventSource cannot set an Authorization header, so the
 * key must stay server-side.
 *
 * The proxy passes `Last-Event-ID` from the browser to the upstream service
 * verbatim, and forwards the `id:` fields in the response so the browser's
 * EventSource can track resume state automatically.
 *
 * The `?types=` query parameter is forwarded to the service so the buffer is
 * filtered upstream; this reduces bytes over both hops.
 *
 * See docs/dashboard-data-contracts.md, "SSE proxy".
 */

import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/authorize";
import { serviceStreamUrl } from "@/lib/service-url";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse | Response> {
  const auth = await authorizeRequest(request, "viewer");
  if (!auth.ok) return auth.response;

  const apiKey = process.env.SERVICE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Service is not configured" }, { status: 503 });
  }

  // Forward the type filter, if any.
  const { searchParams } = new URL(request.url);
  const types = searchParams.get("types");
  const upstream = serviceStreamUrl(types);

  const upstreamHeaders: HeadersInit = {
    authorization: `Bearer ${apiKey}`,
    accept: "text/event-stream",
    "cache-control": "no-cache",
  };

  // Pass the Last-Event-ID header so the upstream can resume from where the
  // browser left off.
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) {
    (upstreamHeaders as Record<string, string>)["last-event-id"] = lastEventId;
  }

  let upstream_response: Response;
  try {
    upstream_response = await fetch(upstream, {
      headers: upstreamHeaders,
      // SSE streams indefinitely; signal from the browser propagates through
      // request.signal automatically in Next.js 15+.
      signal: request.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Client disconnected before the upstream responded.
      return new Response(null, { status: 499 });
    }
    return NextResponse.json({ error: "Stream unavailable" }, { status: 502 });
  }

  if (!upstream_response.ok) {
    return NextResponse.json({ error: "Stream unavailable" }, { status: 502 });
  }

  // Stream the response body back to the browser unchanged. The upstream
  // includes `id:` fields so the browser's EventSource tracks the resume id.
  return new Response(upstream_response.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
