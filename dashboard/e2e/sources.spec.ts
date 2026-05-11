import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("sources", () => {
  test("sources page loads with seeded sources", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/sources`);

    await expect(
      page.getByRole("heading", { name: "Sources", level: 1 }),
    ).toBeVisible();

    // Seed creates 3 sources
    await expect(
      page.getByText("acme-invoices-inbound"),
    ).toBeVisible();
    await expect(
      page.getByText("Partner claims webhook"),
    ).toBeVisible();
  });

  test("sources show type badges", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/sources`);

    // Type badges are displayed for each source
    await expect(page.getByText(/S3|Webhook|Email/i).first()).toBeVisible();
  });

  test("sources show status badges", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/sources`);

    // Should show active status
    await expect(page.getByText("active").first()).toBeVisible();
  });

  test("sources filter buttons work", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/sources`);

    // Filter buttons
    await expect(page.getByRole("button", { name: "All" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Active" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Paused" }),
    ).toBeVisible();

    // Click Paused filter
    await page.getByRole("button", { name: "Paused" }).click();
    // Receipts inbox is paused
    await expect(page.getByText("Receipts inbox")).toBeVisible();
  });

  test("add source dialog opens with type picker", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/sources`);

    await page.getByRole("button", { name: "Add source" }).click();
    await expect(
      page.getByRole("heading", { name: "Add source" }),
    ).toBeVisible();

    // Source type picker should show Webhook option
    await expect(page.getByText("Webhook").first()).toBeVisible();

    // Name field
    await expect(
      page.getByPlaceholder(/partner api inbound/i),
    ).toBeVisible();

    // Cancel
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Add source" }),
    ).not.toBeVisible();
  });
});
