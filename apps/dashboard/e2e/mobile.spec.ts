import { expect, isMobile, signIn, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  test.skip(!isMobile(page), "small-screen layout only");
  await signIn(page);
});

test("the topbar shows the brand and hides the sidebar", async ({ page }) => {
  await page.goto("/agents");

  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "Tollway" })).toBeVisible();
  await expect(page.locator("aside")).toBeHidden();
});

test("the navigation menu opens, navigates, and closes with Escape", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Open navigation" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("navigation", { name: "Dashboard sections" })
    .getByRole("link", { name: "Channels" })
    .click();

  await expect(page).toHaveURL(/\/channels$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Channels");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
});
