import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * Editing a pipeline's model endpoint + parse engine from the detail page.
 * Exercises the full round-trip: open the Configuration section's edit
 * dialog, change the model endpoint, save (PATCH /api/pipelines/:slug),
 * and confirm the persisted value renders back in the config row.
 */
test.describe("pipeline edit configuration", () => {
  test("edit dialog opens with model + parse selectors", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/pipelines/claims-intake`);

    await expect(page.getByText("CONFIGURATION")).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: "Edit configuration" }),
    ).toBeVisible();

    // Seeded chat endpoints populate the model dropdown.
    const modelSelect = page.locator("select").first();
    await expect(modelSelect).toBeVisible();
    await expect(
      modelSelect.locator("option", { hasText: "OpenAI primary" }),
    ).toHaveCount(1);
    await expect(
      modelSelect.locator("option", { hasText: "Anthropic fallback" }),
    ).toHaveCount(1);

    // No parse endpoints seeded → parse dropdown falls back to tenant default.
    const parseSelect = page.locator("select").nth(1);
    await expect(
      parseSelect.locator("option", { hasText: "Tenant default (auto)" }),
    ).toHaveCount(1);

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
    const modelSelect = page.locator("select").first();
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
});
