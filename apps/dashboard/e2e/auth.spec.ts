import { credentials, expect, signIn, signInWithUi, test } from "./fixtures";
import { baseURL } from "./server";

test("redirects a signed-out page request to login and back after sign-in", async ({ page }) => {
  await page.goto("/receipts");
  await expect(page).toHaveURL(/\/login\?next=%2Freceipts$/);

  await signInWithUi(page);

  await expect(page).toHaveURL(/\/receipts$/);
  await expect(page.getByTestId("session-identity")).toHaveText("e2e · viewer");
});

test("answers a signed-out API request with 401", async ({ request }) => {
  const response = await request.get("/api/session");

  expect(response.status()).toBe(401);
});

test("sets an HttpOnly, Secure, SameSite=Lax session cookie", async ({ page }) => {
  await signIn(page);
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === "tollway_dashboard_session",
  );

  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000);
});

test("signs out, and the old cookie no longer works", async ({ page, context }) => {
  await signInWithUi(page);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const before = await context.cookies();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Replaying the cookie captured before sign-out must not get back in.
  await context.addCookies(before);
  await page.goto("/receipts");
  await expect(page).toHaveURL(/\/login\?next=%2Freceipts$/);
  expect((await page.request.get("/api/session")).status()).toBe(401);
});

test("shows one message for a wrong password", async ({ page, consoleErrors }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(credentials.viewer.username);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "Sign-in failed" })).toHaveText(
    "Sign-in failed. Check your credentials and try again.",
  );
  // The browser logs the 401 response itself; that one is expected.
  const unexpected = consoleErrors.filter((text) => !text.includes("401"));
  consoleErrors.length = 0;
  expect(unexpected).toEqual([]);
});

test("refuses a cross-origin sign-in", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    headers: { origin: "http://attacker.example" },
    data: credentials.viewer,
  });

  expect(response.status()).toBe(403);
});

test("refuses a state change without the CSRF token, even signed in as admin", async ({ page }) => {
  await signIn(page, "admin");

  const response = await page.request.delete("/api/admin/sessions/anything", {
    headers: { origin: baseURL },
  });

  expect(response.status()).toBe(403);
});

test("refuses a viewer an admin route at the handler", async ({ page }) => {
  await signIn(page);
  const { csrfToken } = (await (await page.request.get("/api/session")).json()) as {
    csrfToken: string;
  };

  const response = await page.request.delete("/api/admin/sessions/anything", {
    headers: { origin: baseURL, "x-csrf-token": csrfToken },
  });

  expect(response.status()).toBe(403);
});
