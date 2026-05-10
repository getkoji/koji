import { test as setup, expect } from "@playwright/test";

/**
 * Global setup: log in once, save the session cookie.
 *
 * All other test projects reuse the saved storageState so they start
 * already authenticated. Credentials come from env vars (defaults
 * match the seed user created by `kdev dev`).
 */
setup("authenticate", async ({ page }) => {
  const email = process.env.KOJI_TEST_EMAIL ?? "test@koji.test";
  const password = process.env.KOJI_TEST_PASSWORD ?? "testpass123";

  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Wait for redirect to a tenant page (successful login)
  await expect(page).toHaveURL(/\/t\//, { timeout: 10_000 });

  await page.context().storageState({ path: "e2e/.auth/session.json" });
});
