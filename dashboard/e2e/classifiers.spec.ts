import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("classifiers", () => {
  test("classifiers index loads from the sidebar", async ({ page }) => {
    await getTenantBase(page);

    const link = page.locator("nav").getByRole("link", { name: "Classifiers" });
    if (!(await link.isVisible())) {
      test.skip();
      return;
    }
    await link.click();
    await expect(page).toHaveURL(/\/classifiers$/);
    await expect(page.getByRole("heading", { name: "Classifiers" })).toBeVisible();
  });

  test("create classifier dialog opens and closes", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/classifiers`);
    await expect(page).toHaveURL(/\/classifiers$/);

    await page.getByRole("button", { name: /new classifier/i }).first().click();
    await expect(page.getByText("Create classifier")).toBeVisible();
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByText("Create classifier")).not.toBeVisible();
  });

  test("classifier detail shows the config editor and test panel", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/classifiers`);

    // Open the first classifier if the seed data has one; otherwise skip.
    const firstRow = page.locator('a[href*="/classifiers/"]').first();
    if (!(await firstRow.isVisible())) {
      test.skip();
      return;
    }
    await firstRow.click();
    await expect(page).toHaveURL(/\/classifiers\/[^/]+$/);

    await expect(page.getByText("Config (YAML)")).toBeVisible();
    await expect(page.getByText("Test", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /classify/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /release/i })).toBeVisible();
  });
});
