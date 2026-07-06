import { test, expect, type Page } from "@playwright/test";
import { getTenantBase } from "./helpers";

/** Scope locators to the sidebar panel */
function sidebar(page: Page) {
  return page.locator("[data-slot='sidebar']");
}

type Headers = Record<string, string>;

/**
 * Ensure a project exists with a schema unique to it (idempotent — check
 * before create so reruns against a persistent DB don't collide). Creates can
 * also lose a race to a concurrently-provisioning test (fullyParallel), so a
 * failed create falls back to verifying existence instead of asserting on the
 * response. page.request shares the authenticated storageState cookies.
 */
async function provisionProjectWithSchema(
  page: Page,
  h: Headers,
  project: { slug: string; name: string },
  schema: { slug: string; name: string },
) {
  const projects = await (await page.request.get("/api/projects", { headers: h })).json();
  if (!projects.data.some((p: { slug: string }) => p.slug === project.slug)) {
    const r = await page.request.post("/api/projects", {
      headers: h,
      data: { slug: project.slug, display_name: project.name },
    });
    if (!r.ok()) {
      const now = await (await page.request.get("/api/projects", { headers: h })).json();
      expect(now.data.some((p: { slug: string }) => p.slug === project.slug)).toBeTruthy();
    }
  }
  const ph = { ...h, "x-koji-project": project.slug };
  const schemas = await (await page.request.get("/api/schemas", { headers: ph })).json();
  if (!schemas.data.some((s: { slug: string }) => s.slug === schema.slug)) {
    const r = await page.request.post("/api/schemas", {
      headers: ph,
      data: { slug: schema.slug, display_name: schema.name },
    });
    if (!r.ok()) {
      const now = await (await page.request.get("/api/schemas", { headers: ph })).json();
      expect(now.data.some((s: { slug: string }) => s.slug === schema.slug)).toBeTruthy();
    }
  }
}

async function tenantHeaders(page: Page) {
  const tenantBase = await getTenantBase(page);
  const tenantSlug = tenantBase.split("/").pop()!;
  const h: Headers = { "x-koji-tenant": tenantSlug, "Content-Type": "application/json" };
  return { tenantBase, tenantSlug, h };
}

/**
 * Regression for the "project reverts on nav" bug (oss-366).
 *
 * Selecting a project in the sidebar switcher, then clicking any nav item,
 * must keep that project selected — the label stays, and every API request
 * carries the selected project's `x-koji-project` header so the data shown
 * is that project's, not the tenant default's.
 */
test("selected project survives navigation and scopes requests", async ({ page }) => {
  const { tenantBase, h } = await tenantHeaders(page);
  await provisionProjectWithSchema(
    page,
    h,
    { slug: "side", name: "Side Project" },
    { slug: "side_only_schema", name: "Side Only Schema" },
  );

  // Reload so the sidebar picks up the freshly-provisioned project list.
  await page.reload();

  // Open the project switcher and pick "Side Project". Target the trigger by
  // its stable aria-label rather than the tenant's display name, which varies
  // by seed.
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Side Project" }).click();
  await expect(page).toHaveURL(/\/projects\/side/);
  const switcher = page.getByRole("button", { name: "Switch project" });
  await expect(switcher).toContainText("Side Project");

  // Navigate to a nav item whose URL has NO /projects/ segment — the exact
  // case that used to drop the selection — and assert the client still sends
  // the selected project's header.
  const schemasReq = page.waitForRequest(
    (r) => r.url().includes("/api/schemas") && r.method() === "GET",
  );
  await page.goto(`${tenantBase}/pipelines`);
  const req = await schemasReq;
  expect(req.headers()["x-koji-project"]).toBe("side");

  // No revert: the switcher still shows Side Project, and the sidebar's
  // schema list is the side project's.
  await expect(switcher).toContainText("Side Project");
  await expect(page.getByText("side_only_schema")).toBeVisible();
});

/**
 * Regression for the "schema list is one project behind" bug (oss-378).
 *
 * The sidebar lives in the tenant layout and doesn't remount on project
 * switches. It used to refetch schemas via an event emitted BEFORE
 * router.push committed — the API client resolves x-koji-project URL-first,
 * so the refetch went out with the OLD project's slug and the schema list
 * lagged one switch behind until a hard refresh. The switch must update the
 * schema list client-side, without any reload, in both directions.
 *
 * Both projects are provisioned by this test (never the tenant default, and
 * never a project another spec owns — other specs create schema-less projects
 * like "archive", which would leave the sidebar without a schema picker).
 */
test("sidebar schema list follows project switches without a reload", async ({ page }) => {
  const { tenantBase, h } = await tenantHeaders(page);
  await provisionProjectWithSchema(
    page,
    h,
    { slug: "side", name: "Side Project" },
    { slug: "side_only_schema", name: "Side Only Schema" },
  );
  await provisionProjectWithSchema(
    page,
    h,
    { slug: "sidebar-home", name: "Sidebar Home" },
    { slug: "home_only_schema", name: "Home Only Schema" },
  );

  // The sidebar only shows the CURRENT schema slug in the picker trigger;
  // the full project-scoped list lives in the picker dropdown. That dropdown
  // list is exactly what lagged behind, so assert on its contents.
  async function expectSchemaList(present: string, absent: string) {
    await sidebar(page).getByRole("button", { name: "Switch schema" }).click();
    await expect(page.getByRole("menuitem", { name: present })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: absent })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }

  // Fresh load on our home project's overview: its own schemas only.
  await page.goto(`${tenantBase}/projects/sidebar-home`);
  await expectSchemaList("Home Only Schema", "Side Only Schema");

  // Client-side switch to Side Project — NO reload. The schema list must
  // flip to the side project's schemas on its own.
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Side Project" }).click();
  await expect(page).toHaveURL(/\/projects\/side/);
  await expectSchemaList("Side Only Schema", "Home Only Schema");

  // And back again — still no reload.
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Sidebar Home" }).click();
  await expect(page).toHaveURL(/\/projects\/sidebar-home/);
  await expectSchemaList("Home Only Schema", "Side Only Schema");
});
