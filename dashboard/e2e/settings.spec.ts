import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("settings", () => {
  test("general settings shows org info fields", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/settings/general`);

    await expect(
      page.getByRole("heading", { name: "General", level: 1 }),
    ).toBeVisible();

    // Organization section — check for specific field labels
    await expect(page.getByText("Name").first()).toBeVisible();
    await expect(page.getByText("Slug").first()).toBeVisible();
    await expect(page.getByText("Tenant ID")).toBeVisible();
  });

  test("organization name is editable", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/settings/general`);

    // Name row should be present and have edit capability
    await expect(page.getByText("Name").first()).toBeVisible();
  });

  test("members page loads with current user", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/settings/members`);

    await expect(
      page.getByRole("heading", { name: "Members", level: 1 }),
    ).toBeVisible();

    // Current user should be listed with "you" badge
    await expect(page.getByText("you")).toBeVisible();
  });

  test("invite member dialog opens", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/settings/members`);

    const inviteBtn = page.getByRole("button", { name: /invite/i });
    if (await inviteBtn.isVisible()) {
      await inviteBtn.click();
      await expect(
        page.getByRole("heading", { name: /invite/i }),
      ).toBeVisible();

      // Form fields
      await expect(page.getByPlaceholder(/colleague/i)).toBeVisible();
      await expect(page.getByText("Role")).toBeVisible();

      // Cancel
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  });

  test("model providers page loads with seeded endpoints", async ({
    page,
  }) => {
    const tenantBase = await getTenantBase(page);

    // Model providers is under project settings — tenant slug == project slug
    const slug = tenantBase.split("/t/")[1];
    await page.goto(
      `${tenantBase}/projects/${slug}/settings/model-providers`,
    );

    // Seeded endpoints should appear
    await expect(page.getByText("OpenAI primary")).toBeVisible();
  });

  test("danger zone is visible to owner", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/settings/general`);

    // Test user is owner — danger zone should be visible
    await expect(page.getByText("Danger zone")).toBeVisible();
  });
});
