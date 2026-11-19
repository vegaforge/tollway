import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { navItems } from "../src/components/shell/nav";
import { signIn } from "./helpers";

const serious = (impact: string | null | undefined) =>
  impact === "serious" || impact === "critical";

test("login page has no serious accessibility violations", async ({ page }) => {
  await page.goto("/login");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

  expect(results.violations.filter((item) => serious(item.impact))).toEqual([]);
});

for (const item of navItems) {
  test(`${item.label} has no serious accessibility violations`, async ({ page }) => {
    await signIn(page);
    await page.goto(item.href);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

    expect(results.violations.filter((item) => serious(item.impact))).toEqual([]);
  });
}
