import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E tests for the Koji dashboard.
 *
 * Assumes a running dev stack (`kdev dev` + dashboard dev server).
 * Auth is handled via a global setup that logs in once and saves
 * the session cookie for all tests.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,

  reporter: process.env.CI ? "github" : "html",

  use: {
    baseURL: "http://localhost:3002",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "setup",
      testMatch: /global-setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "./e2e/.auth/session.json",
      },
      dependencies: ["setup"],
    },
  ],
});
