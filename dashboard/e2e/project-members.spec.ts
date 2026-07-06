import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * oss-383: manage a project's roster from the project's own settings.
 * Adds a restricted member to the default project with a role, then removes
 * them — driven through the project settings → Members page.
 */
test("adds and removes a member on the project Members page", async ({ page }) => {
  const tenantBase = await getTenantBase(page);
  const tenantSlug = tenantBase.split("/").pop()!;
  const h = { "x-koji-tenant": tenantSlug };

  // Idempotent: if a prior run left Clara granted, revoke her so she's a
  // candidate again (persistent local DB).
  const before = await (await page.request.get(`/api/projects/${tenantSlug}/members`, { headers: h })).json();
  const claraGranted = (before.members ?? []).find((m: { email: string }) => m.email === "clara@koji.test");
  if (claraGranted) {
    await page.request.delete(`/api/projects/${tenantSlug}/members/${claraGranted.membershipId}`, { headers: h });
  }

  // The default project slug matches the workspace slug.
  await page.goto(`${tenantBase}/projects/${tenantSlug}/settings/members`);

  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  // The owner shows as all-access.
  await expect(page.getByText(/All projects/).first()).toBeVisible();
  // Clara (restricted, not yet granted) is NOT listed as a member yet.
  await expect(page.getByText("clara@koji.test")).toHaveCount(0);

  // Add Clara with a role. (The section-header button opens the dialog; the
  // dialog's submit button — rendered later — is the second "Add member".)
  await page.getByRole("button", { name: "Add member" }).first().click();
  await expect(page.getByRole("heading", { name: "Add a member to this project" })).toBeVisible();
  // Member picker defaults to the only candidate (Clara); set role to Editor.
  await page.locator("select").nth(1).selectOption("project-editor");
  await page.getByRole("button", { name: "Add member" }).last().click();

  // Clara now appears as a granted member. She's the only member with a role
  // dropdown (the owner is all-access → a badge), so the single combobox is hers.
  await expect(page.getByText("clara@koji.test")).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveValue("project-editor");

  // Remove Clara.
  await page.getByRole("button", { name: "remove" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("clara@koji.test")).toHaveCount(0);
});
