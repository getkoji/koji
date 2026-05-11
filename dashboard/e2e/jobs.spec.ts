import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("jobs", () => {
  test("jobs list shows seeded jobs", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    await expect(
      page.getByRole("heading", { name: "Jobs", level: 1 }),
    ).toBeVisible();

    // Seed creates jobs — at least one slug should appear
    await expect(page.getByText(/job-\d{8}-\d{4}/).first()).toBeVisible();
  });

  test("jobs list shows metrics strip", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    // Metrics labels are uppercase in the strip
    await expect(page.getByText("TOTAL JOBS")).toBeVisible();
  });

  test("jobs list has status filter buttons", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    // Filter buttons
    await expect(
      page.getByRole("button", { name: "Running" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Succeeded" }),
    ).toBeVisible();
  });

  test("job detail page loads from list", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    // Click the first job row
    const firstJob = page.getByText(/job-\d{8}-\d{4}/).first();
    await firstJob.click();

    // Should navigate to job detail
    await expect(page).toHaveURL(/\/jobs\/job-/);

    // Status badge should be visible
    const statusBadge = page.getByText(
      /running|succeeded|complete|failed|cancel/i,
    );
    await expect(statusBadge.first()).toBeVisible();
  });

  test("job detail shows documents grid", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    // Navigate to first job
    await page.getByText(/job-\d{8}-\d{4}/).first().click();
    await expect(page).toHaveURL(/\/jobs\/job-/);

    // Should show at least one document filename (seeded as *.pdf)
    await expect(page.getByText(/\.pdf/).first()).toBeVisible();
  });

  test("job detail shows pipeline link in metadata", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    await page.getByText(/job-\d{8}-\d{4}/).first().click();
    await expect(page).toHaveURL(/\/jobs\/job-/);

    // Should show a pipeline name in the metadata row
    // The PIPELINE column header should be present
    await expect(page.getByText("PIPELINE").first()).toBeVisible();
  });
});
