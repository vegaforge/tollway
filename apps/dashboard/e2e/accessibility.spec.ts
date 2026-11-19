import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { navItems } from "../src/components/shell/nav";
import { expect, signIn, test } from "./fixtures";

// Every route, in the light, dark and mobile projects. Fails on serious and
// critical violations. No rule is disabled: a finding is a bug to fix in the
// component (Directive 4).

const routes = [
  ...navItems.map((item) => ({ name: item.label, href: item.href })),
  { name: "Agent detail", href: "/agents/agent-research-01" },
];

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
}

/** The project's color scheme must actually reach the page, or "dark" tests light twice. */
async function expectTheme(page: Page) {
  const scheme = test.info().project.use.colorScheme;
  await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /\blight\b/);
}

test("the login page has no serious violations", async ({ page }) => {
  await page.goto("/login");
  await expectTheme(page);

  expect(await seriousViolations(page)).toEqual([]);
});

for (const route of routes) {
  test(`${route.name} has no serious violations`, async ({ page }) => {
    await signIn(page);
    await page.goto(route.href);
    await expect(page.getByTestId("page-header")).toBeVisible();
    await expectTheme(page);

    expect(await seriousViolations(page)).toEqual([]);
  });
}
