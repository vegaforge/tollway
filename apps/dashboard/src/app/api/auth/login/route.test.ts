import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimit } from "../../../../lib/rate-limit";
import { POST } from "./route";

const passwordHash = bcrypt.hashSync("correct horse battery staple", 4);

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", "test-secret");
  vi.stubEnv(
    "DASHBOARD_USERS",
    JSON.stringify([
      {
        username: "viewer",
        passwordHash,
        role: "viewer",
      },
    ]),
  );
  resetRateLimit();
});

function loginRequest(username: string, password: string, origin = "http://localhost") {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      host: "localhost",
    },
    body: JSON.stringify({ username, password }),
  });
}

describe("/api/auth/login", () => {
  it("sets an HttpOnly session cookie for valid credentials", async () => {
    const response = await POST(loginRequest("viewer", "correct horse battery staple"));

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toMatch(/SameSite=lax/i);
    await expect(response.json()).resolves.toMatchObject({
      username: "viewer",
      role: "viewer",
      csrfToken: expect.any(String),
    });
  });

  it("returns the same 401 for an unknown user and a wrong password", async () => {
    const unknown = await POST(loginRequest("missing", "anything"));
    const wrong = await POST(loginRequest("viewer", "wrong"));

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    await expect(unknown.json()).resolves.toEqual({ error: "Invalid credentials" });
    await expect(wrong.json()).resolves.toEqual({ error: "Invalid credentials" });
  });

  it("rejects cross-origin login attempts", async () => {
    const response = await POST(
      loginRequest("viewer", "correct horse battery staple", "http://attacker.test"),
    );

    expect(response.status).toBe(403);
  });

  it("rate limits repeated failures", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await POST(loginRequest("viewer", "wrong"));
    }

    const blocked = await POST(loginRequest("viewer", "correct horse battery staple"));
    expect(blocked.status).toBe(429);
  });
});
