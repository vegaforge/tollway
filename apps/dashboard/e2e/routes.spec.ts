import { navItems } from "../src/components/shell/nav";
import { expect, openNavigation, signIn, test } from "./fixtures";

// Smoke test for every section in the navigation: it loads, shows its
// PageHeader, logs no console error (the fixture checks), and is reachable
// from the navigation, the sidebar on desktop and the menu on mobile.

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

for (const item of navItems) {
  test(`${item.label} loads with its page header`, async ({ page }) => {
    const response = await page.goto(item.href);

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("page-header")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(item.label);
  });

  test(`${item.label} is reachable from the navigation`, async ({ page }) => {
    // Start somewhere else so following the link really navigates.
    await page.goto(item.href === "/exports" ? "/" : "/exports");
    const nav = await openNavigation(page);
    await nav.getByRole("link", { name: item.label, exact: true }).click();

    await expect(page).toHaveURL(new URL(item.href, page.url()).href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(item.label);
    await expect(
      (await openNavigation(page)).getByRole("link", { name: item.label, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });
}

test("an agent detail route loads from the agents table", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("link", { name: "research-bot" }).click();

  await expect(page).toHaveURL(/\/agents\/agent-research-01$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Agent detail");
  await expect(page.getByTestId("agent-series-USDC")).toBeVisible();
  await expect(page.getByTestId("policy-stop-budget-daily")).toBeVisible();
});

test("an unknown agent shows an error, not a crash", async ({ page }) => {
  await page.goto("/agents/nobody");

  await expect(page.getByRole("alert").filter({ hasText: "Could not load" })).toContainText(
    "No agent with id nobody",
  );
});
