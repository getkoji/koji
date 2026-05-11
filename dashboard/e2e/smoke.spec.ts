import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("smoke tests", () => {
  test("dashboard loads after login", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await expect(page).toHaveTitle(/Koji/);
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
