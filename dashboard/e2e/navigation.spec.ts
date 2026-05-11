import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/** Scope locators to the sidebar panel */
function sidebar(page: import("@playwright/test").Page) {
  return page.locator("[data-slot='sidebar']");
}

test.describe("sidebar navigation", () => {
  test("Overview link navigates to project dashboard", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/jobs`); // start elsewhere
    await sidebar(page).getByRole("link", { name: "Overview" }).click();
    await expect(page).toHaveURL(/\/projects\//);
  });

  test("Pipelines link navigates correctly", async ({ page }) => {
    await getTenantBase(page);
    await sidebar(page).getByRole("link", { name: "Pipelines" }).click();
    await expect(page).toHaveURL(/\/pipelines/);
    await expect(
      page.getByRole("heading", { name: "Pipelines", level: 1 }),
    ).toBeVisible();
  });

  test("Jobs link navigates correctly", async ({ page }) => {
    await getTenantBase(page);
    await sidebar(page).getByRole("link", { name: "Jobs" }).click();
    await expect(page).toHaveURL(/\/jobs/);
    await expect(
      page.getByRole("heading", { name: "Jobs", level: 1 }),
    ).toBeVisible();
  });

  test("Review link navigates correctly", async ({ page }) => {
    await getTenantBase(page);
    await sidebar(page).getByRole("link", { name: "Review" }).click();
    await expect(page).toHaveURL(/\/review/);
    await expect(
      page.getByRole("heading", { name: "Review queue", level: 1 }),
    ).toBeVisible();
  });

  test("Sources link navigates correctly", async ({ page }) => {
    await getTenantBase(page);
    await sidebar(page).getByRole("link", { name: "Sources" }).click();
    await expect(page).toHaveURL(/\/sources/);
    await expect(
      page.getByRole("heading", { name: "Sources", level: 1 }),
    ).toBeVisible();
  });

  test("schema sub-nav links load correct pages", async ({ page }) => {
    await getTenantBase(page);

    const buildLink = sidebar(page).getByRole("link", { name: "Build" });
    if (await buildLink.isVisible()) {
      await buildLink.click();
      await expect(page).toHaveURL(/\/schemas\/[^/]+\/build/);

      await sidebar(page).getByRole("link", { name: "Validate" }).click();
      await expect(page).toHaveURL(/\/schemas\/[^/]+\/validate/);

      await sidebar(page).getByRole("link", { name: "Corpus" }).click();
      await expect(page).toHaveURL(/\/schemas\/[^/]+\/corpus/);

      await sidebar(page).getByRole("link", { name: "Performance" }).click();
      await expect(page).toHaveURL(/\/schemas\/[^/]+\/performance/);
    }
  });
});
