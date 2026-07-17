import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * Regression coverage for oss-447:
 *  1. Search text is mirrored into the URL (?q=) and survives back-navigation
 *     — previously a remount reset the box to empty.
 *  2. Multi-word queries match filenames whose words aren't contiguous
 *     ("invoice 0001" finds "invoice-0001.pdf") — previously a single
 *     contiguous ILIKE returned nothing.
 *
 * The seed creates jobs with documents named "invoice-NNNN.pdf" /
 * "claim-NNNN.pdf" / "receipt-NNNN.pdf" (see api/src/seed.ts).
 */
test.describe("jobs search persistence + multi-word", () => {
  test("search is mirrored to ?q= and restored after back-navigation", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`);

    // Wait for the filter bar to render before interacting (avoids racing the
    // initial load).
    const box = page.getByPlaceholder(/search by document name or job ID/i);
    await expect(box).toBeVisible();

    // Widen the date window to "All" so a matching row is guaranteed to render
    // regardless of seed age. (Date "All" is the last such button; the status
    // filter also has one.)
    await page.getByRole("button", { name: "All", exact: true }).last().click();

    await box.fill("invoice");

    // URL picks up the debounced query.
    await expect(page).toHaveURL(/[?&]q=invoice/);

    // A matching job row should be present; open it.
    const jobLink = page.getByText(/job-\d{8}-\d{4}/).first();
    await expect(jobLink).toBeVisible();
    await jobLink.click();
    await expect(page).toHaveURL(/\/jobs\/[^/]+$/);

    // Back should return to the list WITH the search still applied.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]q=invoice/);
    await expect(
      page.getByPlaceholder(/search by document name or job ID/i),
    ).toHaveValue("invoice");
  });

  test("multi-word query matches non-contiguous filename tokens", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);
    // Seed the search via the URL directly — exercises the ?q= seeding path too.
    await page.goto(`${tenantBase}/jobs?q=${encodeURIComponent("invoice 0001")}`);

    await expect(
      page.getByPlaceholder(/search by document name or job ID/i),
    ).toHaveValue("invoice 0001");

    // Widen the date window (seed data can be older than the default 7d).
    await page.getByRole("button", { name: "All", exact: true }).last().click();
    // Re-assert the search survived the filter toggle.
    await expect(
      page.getByPlaceholder(/search by document name or job ID/i),
    ).toHaveValue("invoice 0001");

    // "invoice 0001" (space) must still surface invoice-0001.pdf jobs rather
    // than the "No matching jobs" empty state — the words are not contiguous
    // in the filename, so this only works with tokenized AND matching.
    await expect(page.getByText(/job-\d{8}-\d{4}/).first()).toBeVisible();
    await expect(page.getByText("No matching jobs")).toHaveCount(0);
  });
});
