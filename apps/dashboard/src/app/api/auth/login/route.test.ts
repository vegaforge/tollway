import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimit } from "@/lib/rate-limit";
import { resetSessionStore } from "@/lib/session-store";
import { TEST_SECRET, usersJson, VIEWER_PASSWORD } from "@/test/auth-fixtures";
import { POST } from "./route";

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("DASHBOARD_USERS", usersJson);
  vi.stubEnv("DASHBOARD_ORIGIN", "");
  vi.stubEnv("DASHBOARD_CLIENT_IP_HEADER", "");
  resetRateLimit();
  resetSessionStore();
});

function loginRequest(
  body: unknown,
  { origin = "http://localhost", forwardedFor }: { origin?: string; forwardedFor?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin,
    host: "localhost",
  };
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/api/auth/login", () => {
  it("sets an HttpOnly, Secure, SameSite=Lax session cookie with an expiry", async () => {
    const response = await POST(loginRequest({ username: "viewer", password: VIEWER_PASSWORD }));

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Expires=/i);
    expect(setCookie).toMatch(/Path=\//);
    await expect(response.json()).resolves.toMatchObject({
      username: "viewer",
      role: "viewer",
      csrfToken: expect.any(String),
    });
  });

  it("returns the same 401 for an unknown user and a wrong password", async () => {
    const unknown = await POST(loginRequest({ username: "missing", password: "anything" }));
    const wrong = await POST(loginRequest({ username: "viewer", password: "wrong" }));

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    await expect(unknown.json()).resolves.toEqual({ error: "Invalid credentials" });
    await expect(wrong.json()).resolves.toEqual({ error: "Invalid credentials" });
  });

  it("rejects cross-origin login attempts", async () => {
    const response = await POST(
      loginRequest(
        { username: "viewer", password: VIEWER_PASSWORD },
        { origin: "http://attacker.test" },
      ),
    );

    expect(response.status).toBe(403);
  });

  it.each([
    ["not JSON", "{"],
    ["missing password", { username: "viewer" }],
    ["oversized password", { username: "viewer", password: "x".repeat(1025) }],
    ["empty username", { username: "", password: "x" }],
  ])("rejects a malformed body (%s) with 400", async (_name, body) => {
    const response = await POST(loginRequest(body));

    expect(response.status).toBe(400);
  });

  it("rate limits repeated failures even when X-Forwarded-For changes", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await POST(
        loginRequest(
          { username: "viewer", password: "wrong" },
          { forwardedFor: `203.0.113.${attempt}` },
        ),
      );
    }

    const blocked = await POST(
      loginRequest(
        { username: "viewer", password: VIEWER_PASSWORD },
        { forwardedFor: "203.0.113.99" },
      ),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });
});
