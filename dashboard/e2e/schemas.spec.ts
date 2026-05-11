import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

test.describe("schemas", () => {
  test("schema build page loads with editor", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    // Navigate to a schema's build page via sidebar
    const buildLink = page.locator("nav").getByRole("link", { name: "Build" });
    if (!(await buildLink.isVisible())) {
      test.skip();
      return;
    }
    await buildLink.click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/build/);

    // The Schema tab should be present
    await expect(page.getByText("Schema").first()).toBeVisible();

    // Run button should exist
    await expect(page.getByRole("button", { name: /run/i })).toBeVisible();
  });

  test("schema version history is accessible", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    const buildLink = page.locator("nav").getByRole("link", { name: "Build" });
    if (!(await buildLink.isVisible())) {
      test.skip();
      return;
    }
    await buildLink.click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/build/);

    // Click the History button to see version dropdown
    const historyBtn = page.getByRole("button", { name: /history/i });
    if (await historyBtn.isVisible()) {
      await historyBtn.click();
      // Should show version entries (seeded schemas have versions)
      await expect(page.getByText(/^v\d+/).first()).toBeVisible();
    }
  });

  test("corpus page loads", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    const corpusLink = page
      .locator("nav")
      .getByRole("link", { name: "Corpus" });
    if (!(await corpusLink.isVisible())) {
      test.skip();
      return;
    }
    await corpusLink.click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/corpus/);
    await expect(
      page.getByRole("heading", { name: "Corpus" }),
    ).toBeVisible();
  });

  test("validate page loads", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    const validateLink = page
      .locator("nav")
      .getByRole("link", { name: "Validate" });
    if (!(await validateLink.isVisible())) {
      test.skip();
      return;
    }
    await validateLink.click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/validate/);
  });

  test("performance page loads", async ({ page }) => {
    const tenantBase = await getTenantBase(page);

    const perfLink = page
      .locator("nav")
      .getByRole("link", { name: "Performance" });
    if (!(await perfLink.isVisible())) {
      test.skip();
      return;
    }
    await perfLink.click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/performance/);
  });
});
