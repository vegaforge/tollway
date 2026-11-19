import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionSecret } from "./session";

export function csrfToken(sid: string): string {
  return createHmac("sha256", getSessionSecret()).update(sid).digest("hex");
}

export function isValidCsrf(sid: string, token: string): boolean {
  const expected = csrfToken(sid);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
