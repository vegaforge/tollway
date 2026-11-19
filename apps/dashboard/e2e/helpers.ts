import { expect, type Page } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3124";
const credentials = { username: "e2e", password: "e2e-password" };

export async function signIn(page: Page): Promise<void> {
  const response = await page.request.post(`${baseURL}/api/auth/login`, {
    headers: {
      "content-type": "application/json",
      origin: baseURL,
      host: new URL(baseURL).host,
    },
    data: credentials,
  });

  expect(response.ok()).toBeTruthy();
  await page.goto("/");
}

export async function signInWithUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}
