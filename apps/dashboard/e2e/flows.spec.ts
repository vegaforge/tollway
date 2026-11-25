import { expect, signIn, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("sorts the agents table by spend", async ({ page }) => {
  await page.goto("/agents");
  const firstAgent = page.getByRole("row").nth(1).getByRole("link");
  const spendHeader = page.getByRole("columnheader", { name: /spend/i });

  await expect(spendHeader).toHaveAttribute("aria-sort", "descending");
  await expect(firstAgent).toHaveText("research-bot");

  await spendHeader.getByRole("button").click();

  await expect(spendHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(firstAgent).toHaveText("router");
});

test("selecting a receipt shows its signature as valid", async ({ page }) => {
  await page.goto("/receipts");
  await page.getByTestId("receipt-row-rcpt-x402-stripe-01").click();

  const detail = page.getByTestId("receipt-detail-rcpt-x402-stripe-01");
  await expect(detail.getByTestId("receipt-verification-valid")).toHaveText("Signature valid");
});

test("a channel-commitment receipt links to its channel", async ({ page }) => {
  await page.goto("/receipts");
  await page.getByTestId("receipt-row-rcpt-channel-openai-01").click();
  await page.getByTestId("receipt-channel-link").click();

  await expect(page).toHaveURL(/\/channels\/ch-openai-03$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Channel detail");
  await expect(page.getByTestId("channel-detail")).toContainText("ch-openai-03");
});

test("the theme choice survives a reload", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Toggle color theme" });
  // Before hydration the toggle reports "not pressed" in dark mode too, and a
  // click is lost. Read its state and click only once it has mounted.
  await expect(toggle).toHaveAttribute("data-ready", "true");
  const startsDark = (await toggle.getAttribute("aria-pressed")) === "true";

  await toggle.click();
  const expected = startsDark ? "false" : "true";
  await expect(toggle).toHaveAttribute("aria-pressed", expected);
  await expect(page.locator("html")).toHaveClass(startsDark ? /light/ : /dark/);

  await page.reload();

  const reloaded = page.getByRole("button", { name: "Toggle color theme" });
  await expect(reloaded).toHaveAttribute("data-ready", "true");
  await expect(reloaded).toHaveAttribute("aria-pressed", expected);
  await expect(page.locator("html")).toHaveClass(startsDark ? /light/ : /dark/);
});

test("the agent detail bucket and range controls change the series", async ({ page }) => {
  await page.goto("/agents/agent-research-01");
  const usdc = page.getByTestId("agent-series-USDC");
  await expect(usdc.getByRole("row")).toHaveCount(8);

  await page.getByLabel("Bucket").selectOption("hour");
  await page.getByLabel("Range").selectOption("24h");

  await expect(usdc.getByRole("row")).toHaveCount(25);
  await expect(usdc).toContainText("2026-11-19 10:00 UTC");
});

test("a policy stop links to the anomalies view filtered to the agent", async ({ page }) => {
  await page.goto("/agents/agent-research-01");
  await page.getByRole("link", { name: "View in anomalies" }).click();

  await expect(page).toHaveURL(/\/anomalies\?agent=agent-research-01$/);
  await expect(page.getByTestId("anomalies-agent-filter")).toContainText("agent-research-01");
});
