import { defineConfig, devices } from "@playwright/test";
import { baseURL, port } from "./e2e/server";

/**
 * End-to-end and accessibility suite. It runs against the production build
 * (`next build` happens in the `test:e2e` script, `next start` here) with
 * the deterministic stub data, so every run sees the same pages. See
 * docs/dashboard-data-contracts.md, "End-to-end tests".
 */

// Lets a machine with a system Chromium skip the Playwright download.
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  // No retries: a flaky test is a bug to fix, not a result to retry past.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : undefined,
  },
  projects: [
    {
      name: "light",
      use: { ...devices["Desktop Chrome"], colorScheme: "light" },
    },
    {
      name: "dark",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], colorScheme: "light" },
    },
  ],
  webServer: {
    command: `pnpm exec next start -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Test-only values. The hashes are bcrypt cost 10 of the passwords in
      // e2e/fixtures.ts; no real deployment uses either.
      DASHBOARD_SESSION_SECRET: "playwright-only-session-secret-at-least-32-bytes",
      DASHBOARD_USERS: JSON.stringify([
        {
          username: "e2e",
          passwordHash: "$2b$10$XOB07DhxQPzPxVSlgvHJoOla6KoC5YMMUygiWnHRS0p8/O29kVrWq",
          role: "viewer",
        },
        {
          username: "e2e-admin",
          passwordHash: "$2b$10$gMMFSFGjdZiBguqZkPQubuG5wlNRfZHQNzT7u6WWj8IAoL5gQw/D.",
          role: "admin",
        },
      ]),
    },
  },
});
