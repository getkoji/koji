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
  const candidates: Array<{ email: string; membershipId: string }> = body.candidates ?? [];
  if (candidates.length === 0) {
    test.info().annotations.push({ type: "skip-reason", description: "no candidate member seeded; add/remove flow is covered by integration tests" });
    return;
  }
  const targetEmail = candidates[0].email;

  // Add the candidate with the Editor role.
  await page.getByRole("button", { name: "Add member" }).first().click();
  await expect(page.getByRole("heading", { name: "Add a member to this project" })).toBeVisible();
  await page.getByLabel("Member").selectOption(candidates[0].membershipId);
  await page.getByLabel("Role in this project").selectOption("project-editor");
  await page.getByRole("button", { name: "Add member" }).last().click();

  // The member now appears with a role dropdown set to Editor.
  await expect(page.getByText(targetEmail)).toBeVisible();
  await expect(memberRow(page, targetEmail).getByRole("combobox")).toHaveValue("project-editor");

  // Remove them again — scoped to their row (other rows have remove too).
  await memberRow(page, targetEmail).getByRole("button", { name: "remove" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(targetEmail)).toHaveCount(0);
});

/** The SettingsRow containing a member's email. */
function memberRow(page: import("@playwright/test").Page, email: string) {
  return page.locator("div.flex.items-center.justify-between.px-4").filter({ hasText: email });
}

/**
 * oss-388: an unrestricted NON-admin member (access:"all", workspaceAdmin:false)
 * is manageable from the roster — removing them materializes their implicit
 * all-projects access into explicit grants (they lose this project, keep every
 * other live project, and become a candidate here). Needs such a member seeded —
 * the shared CI seed has only the owner, so this skips there (the materialization
 * logic itself is covered by api/src/routes/projects-members.test.ts).
 */
test("removing an all-projects (non-admin) member materializes their access", async ({ page }) => {
  const tenantBase = await getTenantBase(page);
  const tenantSlug = tenantBase.split("/").pop()!;
  const h = { "x-koji-tenant": tenantSlug };

  const resp = await page.request.get(`/api/projects/${tenantSlug}/members`, { headers: h });
  const body = await resp.json();
  const target = (body.members ?? []).find(
    (m: { access: string; workspaceAdmin?: boolean }) => m.access === "all" && m.workspaceAdmin === false,
  );
  if (!target) {
    test.info().annotations.push({ type: "skip-reason", description: "no unrestricted non-admin member seeded; materialization is covered by integration tests" });
    return;
  }

  await page.goto(`${tenantBase}/projects/${tenantSlug}/settings/members`);
  const row = memberRow(page, target.email);
  // Their row is editable: "all projects" hint + a role select at their default role.
  await expect(row.getByText("all projects")).toBeVisible();
  await expect(row.getByRole("combobox")).toHaveValue(target.defaultRole ?? "project-member");

  // Remove → the confirm explains the switch to project-specific access.
  await row.getByRole("button", { name: "remove" }).click();
  await expect(page.getByText(/currently has access to all projects/)).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(target.email)).toHaveCount(0);

  // Materialized: now restricted, so they surface as a candidate here…
  const after = await (await page.request.get(`/api/projects/${tenantSlug}/members`, { headers: h })).json();
  expect((after.candidates ?? []).map((c: { email: string }) => c.email)).toContain(target.email);
  // …and keep explicit grants elsewhere (never this project).
  const access = await (await page.request.get(`/api/members/${target.membershipId}/project-access`, { headers: h })).json();
  expect(access.restricted).toBe(true);
  expect((access.projects ?? []).map((p: { slug: string }) => p.slug)).not.toContain(tenantSlug);

  // Add them back so shared seed state is restored for other specs.
  await page.getByRole("button", { name: "Add member" }).first().click();
  await page.getByLabel("Member").selectOption(target.membershipId);
  await page.getByRole("button", { name: "Add member" }).last().click();
  await expect(memberRow(page, target.email).getByRole("combobox")).toHaveValue("project-member");
});
