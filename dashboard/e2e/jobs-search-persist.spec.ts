import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * Regression coverage for oss-447:
 *  1. Search text is mirrored into the URL (?q=) and survives back-navigation
 *     — previously a remount reset the box to empty.
 *  2. Multi-word queries match filenames whose words aren't contiguous
 *     ("acme invoice" finds "acme-invoice.pdf") — previously a single
 *     contiguous ILIKE returned nothing.
 */
test.describe("jobs search persistence + multi-word", () => {
  test("search is mirrored to ?q= and restored after back-navigation", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    // Seed jobs may be older than the default 7d window; widen to "All" so a
    // matching row is guaranteed to render. (Date "All" is the last such button;
    // the status filter also has one.)
    await page.getByRole("button", { name: "All", exact: true }).last().click();

    const box = page.getByPlaceholder(/search by document name or job ID/i);
    await box.fill("acme");

    // URL picks up the debounced query.
    await expect(page).toHaveURL(/[?&]q=acme/);

    // A matching job row should be present; open it.
    const jobLink = page.getByText(/job-\d{8}-\d{4}/).first();
    await expect(jobLink).toBeVisible();
    await jobLink.click();
    await expect(page).toHaveURL(/\/jobs\/[^/]+$/);

    // Back should return to the list WITH the search still applied.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]q=acme/);
    await expect(
      page.getByPlaceholder(/search by document name or job ID/i),
    ).toHaveValue("acme");
  });

  test("multi-word query matches non-contiguous filename tokens", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);
    // Seed the search via the URL directly — exercises the ?q= seeding path too.
    await page.goto(`${tenantBase}/jobs?q=${encodeURIComponent("acme invoice")}`);

    await expect(
      page.getByPlaceholder(/search by document name or job ID/i),
    ).toHaveValue("acme invoice");

    // Widen the date window (seed data can be older than 7d).
    await page.getByRole("button", { name: "All", exact: true }).last().click();

    // "acme invoice" (space) must still surface acme-invoice.pdf jobs rather
    // than the "No matching jobs" empty state.
    await expect(page.getByText(/job-\d{8}-\d{4}/).first()).toBeVisible();
    await expect(page.getByText("No matching jobs")).toHaveCount(0);
  });
});
