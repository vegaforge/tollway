import { expect, test } from "@playwright/test";
import { signIn, signInWithUi } from "./helpers";

test("signs in, navigates, and signs out", async ({ page }) => {
  await signInWithUi(page);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.goto("/receipts");
  await expect(page).toHaveURL(/\/receipts$/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/receipts");
  await expect(page).toHaveURL(/\/login\?next=%2Freceipts/);
});

test("toggles the color theme from the keyboard", async ({ page }) => {
  await signIn(page);
  const toggle = page.getByRole("button", { name: "Toggle color theme" });
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  const initial = String(dark);
  await expect(toggle).toHaveAttribute("aria-pressed", initial);

  await toggle.focus();
  await page.keyboard.press("Enter");

  await expect(toggle).toHaveAttribute("aria-pressed", initial === "true" ? "false" : "true");
});
