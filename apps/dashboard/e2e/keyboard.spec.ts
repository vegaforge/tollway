import type { Locator, Page } from "@playwright/test";
import { navItems } from "../src/components/shell/nav";
import { expect, isMobile, signIn, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/** A focused element must draw an outline or a ring, not rely on the browser's absence of one. */
async function expectVisibleFocus(locator: Locator) {
  const style = await locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      outline: computed.outlineStyle,
      width: computed.outlineWidth,
      shadow: computed.boxShadow,
    };
  });
  const outlined = style.outline !== "none" && style.width !== "0px";
  expect(outlined || style.shadow !== "none", `visible focus, got ${JSON.stringify(style)}`).toBe(
    true,
  );
}

async function focused(page: Page) {
  return page.locator(":focus");
}

test("the first Tab reaches a skip link that moves focus to the content", async ({ page }) => {
  await page.goto("/agents");
  await page.keyboard.press("Tab");

  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await expectVisibleFocus(skip);

  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();
});

test("Tab reaches every section link with visible focus", async ({ page }) => {
  test.skip(
    isMobile(page),
    "the sidebar is hidden on small screens; mobile.spec.ts covers the menu",
  );
  await page.goto("/");
  const reached = new Set<string>();

  for (let step = 0; step < 40 && reached.size < navItems.length; step += 1) {
    await page.keyboard.press("Tab");
    const element = await focused(page);
    const text = (await element.textContent())?.trim() ?? "";
    const match = navItems.find((item) => item.label === text);
    if (match && (await element.evaluate((node) => node.closest("aside") !== null))) {
      await expectVisibleFocus(element);
      reached.add(match.label);
    }
  }

  expect([...reached].sort()).toEqual(navItems.map((item) => item.label).sort());
});

test("a receipt row can be selected from the keyboard", async ({ page }) => {
  await page.goto("/receipts");
  const select = page.getByTestId("receipt-select-rcpt-mppcharge-anthropic-01");

  await select.focus();
  await expectVisibleFocus(select);
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("receipt-row-rcpt-mppcharge-anthropic-01")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("receipt-detail-rcpt-mppcharge-anthropic-01")).toBeVisible();
});

test("the agents sort control works from the keyboard", async ({ page }) => {
  await page.goto("/agents");
  const sort = page.getByRole("columnheader", { name: /spend/i }).getByRole("button");

  await sort.focus();
  await expectVisibleFocus(sort);
  await page.keyboard.press("Space");

  await expect(page.getByRole("columnheader", { name: /spend/i })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
});

test("the services sort controls work from the keyboard", async ({ page }) => {
  await page.goto("/services");
  const payments = page.getByRole("columnheader", { name: /payments/i });
  const sort = payments.getByRole("button");

  await sort.focus();
  await expectVisibleFocus(sort);
  await page.keyboard.press("Enter");

  await expect(payments).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByRole("rowheader").first()).toContainText("Weather API");
});
