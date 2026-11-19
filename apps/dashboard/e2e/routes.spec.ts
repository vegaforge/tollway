import { expect, test } from "@playwright/test";
import { navItems } from "../src/components/shell/nav";
import { signIn } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

for (const item of navItems) {
  test(`renders ${item.label} without a server error`, async ({ page }) => {
    const response = await page.goto(item.href);

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("page-header")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(item.label);
  });
}

test("renders an agent detail route", async ({ page }) => {
  const response = await page.goto("/agents/agent-research-01");

  expect(response?.status()).toBe(200);
  await expect(page.getByText("research-bot")).toBeVisible();
});

test("redirects unauthenticated page requests to login", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/receipts");

  await expect(page).toHaveURL(/\/login\?next=%2Freceipts/);
});
