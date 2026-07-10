import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * Editing a pipeline's configuration (schema, model endpoint, parse engine,
 * review threshold) from the detail page. Exercises the full round-trip: open
 * the Configuration section's edit dialog, change values, save
 * (PATCH /api/pipelines/:slug), and confirm the persisted values render back
 * in the config rows.
 *
 * Selects are located by a distinguishing option rather than by position, so
 * the tests don't break when a field is added/reordered in the dialog.
 */

// The select containing the given option text (e.g. "OpenAI primary").
const selectWithOption = (page: import("@playwright/test").Page, optionText: string) =>
  page.locator("select").filter({
    has: page.locator("option", { hasText: optionText }),
  });

test.describe("pipeline edit configuration", () => {
  test("edit dialog opens with schema, model, parse, and threshold controls", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    await expect(page.getByText("CONFIGURATION")).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).toBeVisible();

    // Schema dropdown populated with seeded schemas.
    const schemaSelect = selectWithOption(page, "Invoice");
    await expect(schemaSelect).toBeVisible();
    await expect(
      schemaSelect.locator("option", { hasText: "Insurance Claim" }),
    ).toHaveCount(1);

    // Seeded chat endpoints populate the model dropdown.
    const modelSelect = selectWithOption(page, "OpenAI primary");
    await expect(
      modelSelect.locator("option", { hasText: "Anthropic fallback" }),
    ).toHaveCount(1);

    // No parse endpoints seeded → parse dropdown falls back to tenant default.
    await expect(selectWithOption(page, "Tenant default (auto)")).toBeVisible();

    // Review threshold input prefilled from the pipeline.
    const thresholdInput = page.locator('input[type="number"][max="1"]');
    await expect(thresholdInput).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).not.toBeVisible();
  });

  test("changing the model endpoint persists to the config row", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).toBeVisible();

    // Select the Anthropic fallback endpoint (resolve its option value so we
    // don't depend on the exact em-dash label formatting).
    const modelSelect = selectWithOption(page, "OpenAI primary");
    const anthropicValue = await modelSelect
      .locator("option", { hasText: "Anthropic fallback" })
      .getAttribute("value");
    expect(anthropicValue).toBeTruthy();
    await modelSelect.selectOption(anthropicValue!);

    await page.getByRole("button", { name: "Save changes" }).click();

    // Dialog closes on success and the config row reflects the new endpoint.
    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).not.toBeVisible();
    await expect(page.getByText("Anthropic fallback")).toBeVisible();

    // Reload to confirm it was actually persisted (not just optimistic UI).
    await page.reload();
    await expect(page.getByText("Anthropic fallback")).toBeVisible();
  });

  test("changing the review threshold persists to the config row", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/invoice-ingest`);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).toBeVisible();

    const thresholdInput = page.locator('input[type="number"][max="1"]');
    await thresholdInput.fill("0.72");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).not.toBeVisible();
    await expect(page.getByText("0.72")).toBeVisible();

    await page.reload();
    await expect(page.getByText("0.72")).toBeVisible();
  });

  test("rejects an out-of-range review threshold", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/receipt-scan`);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).toBeVisible();

    const thresholdInput = page.locator('input[type="number"][max="1"]');
    await thresholdInput.fill("5");
    await page.getByRole("button", { name: "Save changes" }).click();

    // Client-side guard blocks the save and surfaces an error; dialog stays open.
    await expect(
      page.getByText("Review threshold must be a number between 0 and 1."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).toBeVisible();
  });
});
