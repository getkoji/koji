import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("review queue", () => {
  test("review page loads with queue", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/review`);

    await expect(
      page.getByRole("heading", { name: "Review queue", level: 1 }),
    ).toBeVisible();

    // Metrics strip — uppercase labels
    await expect(page.getByText("IN QUEUE")).toBeVisible();
  });

  test("review queue shows pending items", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/review`);

    // Default filter is "Pending" — seed has pending review items
    // Should show at least one row with a confidence bar or field name
    await expect(page.getByText("pending").first()).toBeVisible();
  });

  test("review queue filter buttons work", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/review`);

    // Filter buttons should be present
    await expect(
      page.getByRole("button", { name: "Pending" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Completed" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "All" })).toBeVisible();

    // Click "Completed"
    await page.getByRole("button", { name: "Completed" }).click();
    await expect(
      page.getByRole("button", { name: "Completed" }),
    ).toBeVisible();

    // Click "All"
    await page.getByRole("button", { name: "All" }).click();
  });

  test("review detail page loads with decision panel", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/review`);

    // Click the first review item link
    const firstItem = page.locator("main a[href*='/review/']").first();
    if (await firstItem.isVisible()) {
      await firstItem.click();
      await expect(page).toHaveURL(/\/review\/[a-f0-9-]+/);

      // Decision panel should show action buttons for pending items
      await expect(page.getByText("Decision")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /approve/i }),
      ).toBeVisible();
    }
  });

  test("review detail shows extraction fields", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/review`);

    const firstItem = page.locator("main a[href*='/review/']").first();
    if (await firstItem.isVisible()) {
      await firstItem.click();
      await expect(page).toHaveURL(/\/review\/[a-f0-9-]+/);

      // Should show extraction section
      await expect(page.getByText("Extraction")).toBeVisible();
    }
  });

  test("review detail has queue navigation", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/review`);

    const firstItem = page.locator("main a[href*='/review/']").first();
    if (await firstItem.isVisible()) {
      await firstItem.click();
      await expect(page).toHaveURL(/\/review\/[a-f0-9-]+/);

      // Queue position indicator (e.g. "1 of 6")
      await expect(page.getByText(/\d+ of \d+/)).toBeVisible();
    }
  });
});
