import { test, expect } from "@playwright/test";

/**
 * Helper: navigate to root, wait for redirect to /t/<slug>, return
 * the tenant base path (e.g. "/t/my-org").
 */
async function getTenantBase(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/t\//);
  const match = new URL(page.url()).pathname.match(/^\/t\/[^/]+/);
  expect(match).toBeTruthy();
  return match![0];
}

test.describe("smoke tests", () => {
  test("dashboard loads after login", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    // Page title should be set
    await expect(page).toHaveTitle(/Koji/);

    // Should land on the tenant overview
    expect(page.url()).toContain(tenantBase);
  });

  test("pipelines page loads", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    await page.goto(`${tenantBase}/pipelines`);
    await expect(
      page.getByRole("heading", { name: "Pipelines", level: 1 }),
    ).toBeVisible();
  });

  test("settings page loads", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    // /settings redirects to /settings/general
    await page.goto(`${tenantBase}/settings`);
    await expect(page).toHaveURL(/\/settings\/general/);
    await expect(
      page.getByRole("heading", { name: "General", level: 1 }),
    ).toBeVisible();
  });

  test("jobs page loads", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    await page.goto(`${tenantBase}/jobs`);
    await expect(
      page.getByRole("heading", { name: "Jobs", level: 1 }),
    ).toBeVisible();
  });
});
