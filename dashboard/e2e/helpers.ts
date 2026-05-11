import { expect, type Page } from "@playwright/test";

/**
 * Navigate to root, wait for redirect to /t/<slug>, return the
 * tenant base path (e.g. "/t/my-org").
 */
export async function getTenantBase(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/t\//);
  const match = new URL(page.url()).pathname.match(/^\/t\/[^/]+/);
  expect(match).toBeTruthy();
  return match![0];
}

/**
 * Extract the project slug from the overview redirect.
 * Root `/t/<slug>` redirects to `/t/<slug>/projects/<projectSlug>`.
 */
export async function getProjectBase(page: Page): Promise<string> {
  const tenantBase = await getTenantBase(page);
  await expect(page).toHaveURL(/\/projects\//);
  const match = new URL(page.url()).pathname.match(
    /^\/t\/[^/]+\/projects\/[^/]+/,
  );
  expect(match).toBeTruthy();
  return match![0];
}
