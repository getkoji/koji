import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("pipelines", () => {
  test("pipelines list shows seeded pipelines", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines`);

    await expect(
      page.getByRole("heading", { name: "Pipelines", level: 1 }),
    ).toBeVisible();

    // Seed creates pipelines — check they appear
    await expect(page.getByText("Claims Intake")).toBeVisible();
    await expect(page.getByText("Invoice Ingest")).toBeVisible();
    await expect(page.getByText("Receipt Scan")).toBeVisible();
  });

  test("pipeline list shows status badges", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines`);

    // Seed has active and paused pipelines — badges are uppercase
    await expect(page.getByText("ACTIVE").first()).toBeVisible();
  });

  test("pipeline list shows metrics strip", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines`);

    // Metrics strip has "DOCS PROCESSED" and "ACTIVE" labels
    await expect(page.getByText("DOCS PROCESSED")).toBeVisible();
    await expect(page.getByText("ACTIVE").first()).toBeVisible();
  });

  test("create pipeline dialog opens with form fields", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines`);

    await page
      .getByRole("button", { name: /create pipeline/i })
      .click();
    await expect(
      page.getByRole("heading", { name: "Create pipeline" }),
    ).toBeVisible();

    // Form fields visible in the dialog
    await expect(page.getByPlaceholder("e.g. Claims Intake")).toBeVisible();
    await expect(page.getByPlaceholder("my-pipeline")).toBeVisible();
    await expect(page.getByText("Review threshold")).toBeVisible();

    // Cancel closes the dialog
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Create pipeline" }),
    ).not.toBeVisible();
  });

  test("pipeline detail page loads", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    // Detail page should show key sections (uppercase labels)
    await expect(
      page.getByRole("heading", { name: "Claims Intake", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("DEPLOYMENT")).toBeVisible();
    await expect(page.getByText("CONFIGURATION")).toBeVisible();
  });

  test("pipeline detail shows action buttons", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    // Should have pause/resume and run buttons
    const pauseOrResume = page.getByRole("button", {
      name: /pause|resume/i,
    });
    await expect(pauseOrResume).toBeVisible();

    // Run pipeline button
    await expect(
      page.getByRole("button", { name: /run pipeline/i }),
    ).toBeVisible();
  });

  test("deploy dialog shows schema versions", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    const deployBtn = page.getByRole("button", {
      name: /change schema version/i,
    });
    if (await deployBtn.isVisible()) {
      await deployBtn.click();
      await expect(
        page.getByRole("heading", { name: /change schema version/i }),
      ).toBeVisible();

      // Should show version entries
      await expect(page.getByText(/^v\d+/).first()).toBeVisible();

      // Close
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  });

  test("pipeline danger zone has delete button", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    await expect(page.getByText("Danger zone")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Delete" }),
    ).toBeVisible();
  });

  test("run pipeline dialog opens", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    await page.getByRole("button", { name: /run pipeline/i }).click();
    await expect(
      page.getByRole("heading", { name: /run pipeline/i }),
    ).toBeVisible();

    // Should show file upload zone
    await expect(
      page.getByText("Drop files or pick them"),
    ).toBeVisible();

    // Cancel
    await page.getByRole("button", { name: "Cancel" }).click();
  });
});
