import { test as base, expect, type Page } from "@playwright/test";
import { baseURL } from "./server";

/**
 * Shared fixtures for the dashboard suite. Every test gets a page that
 * records console errors and uncaught exceptions, and fails at the end if
 * any appeared: a hydration mismatch, for example, only shows up there.
 */

export const credentials = {
  viewer: { username: "e2e", password: "e2e-password" },
  admin: { username: "e2e-admin", password: "e2e-admin-password" },
} as const;

type Fixtures = { consoleErrors: string[] };

export const test = base.extend<Fixtures>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await use(errors);
      expect(errors, "console errors during the test").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Signs in through the API, which shares the page's cookie jar. */
export async function signIn(page: Page, role: keyof typeof credentials = "viewer") {
  const response = await page.request.post("/api/auth/login", {
    // A browser sends Origin on a cross-origin-capable POST; the API client
    // does not, and the login route refuses a request without one.
    headers: { origin: baseURL },
    data: credentials[role],
  });
  expect(response.status(), "sign-in through the API").toBe(200);
}

/** Fills the login form; stays on the current login URL so its `next` parameter is kept. */
export async function signInWithUi(page: Page, role: keyof typeof credentials = "viewer") {
  if (new URL(page.url(), baseURL).pathname !== "/login") await page.goto("/login");
  await page.getByLabel("Username").fill(credentials[role].username);
  await page.getByLabel("Password").fill(credentials[role].password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** True for the mobile project, where the sidebar is hidden behind a menu. */
export function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/** Opens the section menu on small screens; a no-op where the sidebar shows. */
export async function openNavigation(page: Page) {
  if (isMobile(page)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  return page.getByRole("navigation", { name: "Dashboard sections" });
}
