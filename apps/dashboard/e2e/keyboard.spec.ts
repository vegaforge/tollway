import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("receipt rows can be selected from the keyboard", async ({ page }) => {
  await signIn(page);
  await page.goto("/receipts");

  const row = page.locator('[data-testid^="receipt-row-"]').first();
  const testId = await row.getAttribute("data-testid");
  if (!testId) {
    throw new Error("Receipt row has no data-testid");
  }

  const select = page.getByTestId(testId.replace("receipt-row-", "receipt-select-"));
  await select.focus();
  await page.keyboard.press("Enter");

  await expect(row).toHaveAttribute("data-selected", "true");
});
