import { beforeEach, describe, expect, it, vi } from "vitest";
import { session, TEST_SECRET, usersJson, viewerHash } from "@/test/auth-fixtures";
import { csrfToken, isSameOrigin, isValidCsrf } from "./csrf";
import { credentialsProvider, loadConfiguredUsers, loadIdentityProvider } from "./identity";
import {
  isRateLimited,
  MAX_FAILURES_GLOBAL,
  MAX_FAILURES_PER_CLIENT,
  MAX_FAILURES_PER_USERNAME,
  recordFailure,
  resetRateLimit,
  trustedClientAddress,
} from "./rate-limit";
import { safeNextPath } from "./safe-redirect";
import {
  COOKIE_NAME,
  createSessionToken,
  hasRole,
  readSession,
  requireRole,
  verifySessionToken,
} from "./session";
import {
  isActiveSession,
  rememberSession,
  resetSessionStore,
  revokeSession,
} from "./session-store";

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("DASHBOARD_USERS", usersJson);
  vi.stubEnv("DASHBOARD_ORIGIN", "");
  vi.stubEnv("DASHBOARD_CLIENT_IP_HEADER", "");
  vi.stubEnv("DASHBOARD_AUTH_PROVIDER", "");
  resetSessionStore();
  resetRateLimit();
});

describe("session tokens", () => {
  it("round-trips a signed session and rejects tampering", async () => {
    const value = session();
    const token = await createSessionToken(value);

    await expect(verifySessionToken(token)).resolves.toEqual(value);
    await expect(verifySessionToken(`${token}tampered`)).resolves.toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await createSessionToken(session());
    vi.stubEnv("DASHBOARD_SESSION_SECRET", "another-secret-that-is-also-32-bytes-or-more");

    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it("rejects an expired session", async () => {
    const token = await createSessionToken(session({ exp: 1 }));

    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it("refuses to run without a secret rather than treating everyone as signed out", async () => {
    vi.stubEnv("DASHBOARD_SESSION_SECRET", "");

    await expect(verifySessionToken("anything")).rejects.toThrow(/not configured/);
  });

  it("reads the session cookie from a request", async () => {
    const value = session();
    const token = await createSessionToken(value);
    const request = new Request("http://localhost/", {
      headers: { cookie: `other=1; ${COOKIE_NAME}=${token}` },
    });

    await expect(readSession(request)).resolves.toEqual(value);
  });

  it("returns null when the cookie is absent", async () => {
    await expect(readSession(new Request("http://localhost/"))).resolves.toBeNull();
  });
});

describe("roles", () => {
  it("ranks admin above viewer", () => {
    expect(hasRole("admin", "viewer")).toBe(true);
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("viewer", "viewer")).toBe(true);
    expect(hasRole("viewer", "admin")).toBe(false);
  });

  it("denies a viewer an admin-only check", () => {
    expect(() => requireRole(session(), "admin")).toThrow("Forbidden");
  });
});

describe("session store", () => {
  it("marks revoked, unknown, expired and altered sessions inactive", () => {
    const value = session();
    rememberSession(value);
    expect(isActiveSession(value)).toBe(true);
    expect(isActiveSession({ ...value, role: "admin" })).toBe(false);
    expect(isActiveSession({ ...value, sid: "missing" })).toBe(false);

    expect(revokeSession(value.sid)).toBe(true);
    expect(isActiveSession(value)).toBe(false);
    expect(revokeSession("missing")).toBe(false);
  });

  it("treats a session past its expiry as inactive", () => {
    const value = session({ exp: Math.floor(Date.now() / 1000) - 1 });
    rememberSession(value);

    expect(isActiveSession(value)).toBe(false);
  });
});

describe("request defences", () => {
  function post(origin: string | null, host = "localhost") {
    const headers: Record<string, string> = { host };
    if (origin !== null) headers.origin = origin;
    return new Request("http://localhost/api/auth/login", { method: "POST", headers });
  }

  it("accepts only a same-origin Origin header", () => {
    expect(isSameOrigin(post("http://localhost"))).toBe(true);
    expect(isSameOrigin(post("http://attacker.test"))).toBe(false);
    expect(isSameOrigin(post(null))).toBe(false);
    expect(isSameOrigin(post("not a url"))).toBe(false);
  });

  it("compares with DASHBOARD_ORIGIN exactly when it is set", () => {
    vi.stubEnv("DASHBOARD_ORIGIN", "https://dash.example");

    expect(isSameOrigin(post("https://dash.example", "internal:3000"))).toBe(true);
    expect(isSameOrigin(post("http://dash.example", "internal:3000"))).toBe(false);
  });

  it("binds the CSRF token to the session", () => {
    const token = csrfToken("session-1");

    expect(isValidCsrf("session-1", token)).toBe(true);
    expect(isValidCsrf("other-session", token)).toBe(false);
    expect(isValidCsrf("session-1", "")).toBe(false);
  });
});

describe("login rate limit", () => {
  it("blocks a username after repeated failures from any source", () => {
    for (let attempt = 0; attempt < MAX_FAILURES_PER_USERNAME; attempt += 1) {
      const subject = { username: "viewer", client: `198.51.100.${attempt}` };
      expect(isRateLimited(subject)).toBe(false);
      recordFailure(subject);
    }
    expect(isRateLimited({ username: "viewer", client: "198.51.100.200" })).toBe(true);
    expect(isRateLimited({ username: "VIEWER", client: null })).toBe(true);
    expect(isRateLimited({ username: "admin", client: null })).toBe(false);
  });

  it("forgets failures after the window", () => {
    const start = 1_000_000;
    for (let attempt = 0; attempt < MAX_FAILURES_PER_USERNAME; attempt += 1) {
      recordFailure({ username: "viewer", client: null }, start);
    }
    expect(isRateLimited({ username: "viewer", client: null }, start)).toBe(true);
    expect(isRateLimited({ username: "viewer", client: null }, start + 60_000)).toBe(false);
  });

  it("blocks one client spraying usernames, when a trusted header is configured", () => {
    for (let attempt = 0; attempt < MAX_FAILURES_PER_CLIENT; attempt += 1) {
      recordFailure({ username: `user-${attempt}`, client: "198.51.100.7" });
    }
    expect(isRateLimited({ username: "fresh", client: "198.51.100.7" })).toBe(true);
    expect(isRateLimited({ username: "fresh", client: "198.51.100.8" })).toBe(false);
  });

  it("caps total failures across every username", () => {
    for (let attempt = 0; attempt < MAX_FAILURES_GLOBAL; attempt += 1) {
      recordFailure({ username: `user-${attempt}`, client: null });
    }
    expect(isRateLimited({ username: "fresh", client: null })).toBe(true);
  });

  it("reads the client address only from the configured header", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "203.0.113.1", "x-real-ip": "198.51.100.9" },
    });
    expect(trustedClientAddress(request)).toBeNull();

    vi.stubEnv("DASHBOARD_CLIENT_IP_HEADER", "x-real-ip");
    expect(trustedClientAddress(request)).toBe("198.51.100.9");
  });
});

describe("identity provider", () => {
  it("authenticates a configured user and refuses a wrong password", async () => {
    const provider = loadIdentityProvider();

    await expect(provider.authenticate("viewer", "correct horse battery staple")).resolves.toEqual({
      username: "viewer",
      role: "viewer",
    });
    await expect(provider.authenticate("viewer", "wrong")).resolves.toBeNull();
    await expect(provider.authenticate("nobody", "anything")).resolves.toBeNull();
  });

  it("runs bcrypt for an unknown username too, so timing does not reveal it", async () => {
    const bcrypt = await import("bcryptjs");
    const compare = vi.spyOn(bcrypt.default, "compare");
    const provider = credentialsProvider(loadConfiguredUsers());

    await provider.authenticate("nobody", "anything");

    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]?.[1]).toMatch(/^\$2[aby]\$10\$/);
    compare.mockRestore();
  });

  it("refuses misconfigured users at load", () => {
    const user = { username: "viewer", passwordHash: viewerHash, role: "viewer" };
    expect(() => loadConfiguredUsers("not json")).toThrow(/not JSON/);
    expect(() => loadConfiguredUsers("[]")).toThrow(/non-empty/);
    expect(() => loadConfiguredUsers(JSON.stringify([{ ...user, role: "owner" }]))).toThrow(/role/);
    expect(() =>
      loadConfiguredUsers(JSON.stringify([{ ...user, passwordHash: "plain-text" }])),
    ).toThrow(/not a bcrypt hash/);
    expect(() =>
      loadConfiguredUsers(
        JSON.stringify([{ ...user, passwordHash: viewerHash.replace("$10$", "$04$") }]),
      ),
    ).toThrow(/cost is below 10/);
    expect(() => loadConfiguredUsers(JSON.stringify([user, user]))).toThrow(/duplicate/);
  });

  it("refuses an unknown provider name", () => {
    vi.stubEnv("DASHBOARD_AUTH_PROVIDER", "saml");

    expect(() => loadIdentityProvider()).toThrow(/not supported/);
  });
});

describe("post-login redirect", () => {
  it.each([
    [null, "/"],
    ["/receipts", "/receipts"],
    ["/agents/agent-1?bucket=hour", "/agents/agent-1?bucket=hour"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["javascript:alert(1)", "/"],
  ])("maps %s to %s", (requested, expected) => {
    expect(safeNextPath(requested)).toBe(expected);
  });
});
