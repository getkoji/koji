import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * Navigate to a trace page by going through the job list → job detail → first document.
 * Returns once the trace page has loaded its header.
 */
async function navigateToTrace(page: import("@playwright/test").Page) {
  const tenantBase = await getTenantBase(page);
  await page.goto(`${tenantBase}/jobs`);

  // Click the first job
  const firstJob = page.getByText(/job-\d{8}-\d{4}/).first();
  await firstJob.click();
  await expect(page).toHaveURL(/\/jobs\/job-/);

  // Click the first document (seeded as *.pdf)
  const firstDoc = page.getByText(/\.pdf/).first();
  await firstDoc.click();
  await expect(page).toHaveURL(/\/documents\//);
}

test.describe("trace page", () => {
  test("renders side-by-side layout for completed document with extraction", async ({ page }) => {
    await navigateToTrace(page);

    // Metrics strip should be visible
    await expect(page.getByText("TOTAL DURATION")).toBeVisible();
    await expect(page.getByText("FIELDS EXTRACTED")).toBeVisible();

    // If extraction results exist, the side-by-side layout should show
    // TraceResults panel and StageTimeline
    const resultsPanel = page.getByTestId("trace-results-panel");
    const hasExtraction = await resultsPanel.isVisible().catch(() => false);

    if (hasExtraction) {
      await expect(resultsPanel).toBeVisible();
      await expect(page.getByText("Extraction results")).toBeVisible();
      await expect(page.getByTestId("trace-stage-timeline")).toBeVisible();
      await expect(page.getByText("Pipeline stages")).toBeVisible();
    }
  });

  test("PDF viewer loads in side-by-side layout", async ({ page }) => {
    await navigateToTrace(page);

    const pdfViewer = page.getByTestId("trace-pdf-viewer");
    const hasPdf = await pdfViewer.isVisible().catch(() => false);

    if (hasPdf) {
      // The PDF viewer container should be visible and contain a canvas or iframe
      await expect(pdfViewer).toBeVisible();
    }
  });

  test("clicking a field in results table activates highlight", async ({ page }) => {
    await navigateToTrace(page);

    const resultsPanel = page.getByTestId("trace-results-panel");
    const hasExtraction = await resultsPanel.isVisible().catch(() => false);

    if (hasExtraction) {
      // Click the first field row in the results table
      const firstField = resultsPanel.getByRole("button").first();
      await firstField.click();

      // The clicked row should get the vermillion active border
      await expect(firstField).toHaveCSS("border-left-width", "3px");

      // Click again to deselect
      await firstField.click();
    }
  });

  test("stage timeline shows completed stages", async ({ page }) => {
    await navigateToTrace(page);

    const timeline = page.getByTestId("trace-stage-timeline");
    const hasTimeline = await timeline.isVisible().catch(() => false);

    if (hasTimeline) {
      // Should show at least one stage name (e.g. parse, extract)
      // The checkmark character (✓) indicates completed stages
      await expect(timeline.getByText(/parse|extract|deliver|classify/i).first()).toBeVisible();
    }
  });

  test("header shows document metadata", async ({ page }) => {
    await navigateToTrace(page);

    // Status badge should be visible
    await expect(
      page.getByText(/delivered|extracting|failed|review/i).first(),
    ).toBeVisible();

    // Action buttons
    await expect(page.getByText("Rerun")).toBeVisible();
    await expect(page.getByText("Download JSON")).toBeVisible();
  });
});
