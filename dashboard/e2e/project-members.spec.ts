import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * oss-383: manage a project's roster from the project's own settings.
 *
 * The page always shows the owner as an all-access member. The add→role→remove
 * flow needs a *candidate* (a restricted member not yet on the project), which
 * only exists when the environment seeds one — the shared CI seed has only the
 * owner. So we always assert the render + all-access row, and exercise the full
 * management flow only when a candidate is present (the endpoint logic itself is
 * covered exhaustively by api/src/routes/projects-members.test.ts).
 */
test("project Members page renders; manages a member when a candidate exists", async ({ page }) => {
  const tenantBase = await getTenantBase(page);
  const tenantSlug = tenantBase.split("/").pop()!;
  const h = { "x-koji-tenant": tenantSlug };

  // The default project slug matches the workspace slug.
  await page.goto(`${tenantBase}/projects/${tenantSlug}/settings/members`);
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  // The owner (logged-in user) is all-access.
  await expect(page.getByText(/All projects/).first()).toBeVisible();

  // The add→role→remove flow needs a candidate (a restricted member not yet on
  // this project). Only present when the environment seeds one.
  const resp = await page.request.get(`/api/projects/${tenantSlug}/members`, { headers: h });
  const body = await resp.json();
  const candidates: Array<{ email: string }> = body.candidates ?? [];
  if (candidates.length === 0) {
    test.info().annotations.push({ type: "skip-reason", description: "no candidate member seeded; add/remove flow is covered by integration tests" });
    return;
  }
  const targetEmail = candidates[0].email;

  // Add the candidate with the Editor role.
  await page.getByRole("button", { name: "Add member" }).first().click();
  await expect(page.getByRole("heading", { name: "Add a member to this project" })).toBeVisible();
  await page.locator("select").nth(1).selectOption("project-editor");
  await page.getByRole("button", { name: "Add member" }).last().click();

  // The member now appears with a role dropdown set to Editor.
  await expect(page.getByText(targetEmail)).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveValue("project-editor");

  // Remove them again.
  await page.getByRole("button", { name: "remove" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(targetEmail)).toHaveCount(0);
});
