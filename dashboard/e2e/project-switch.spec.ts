import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * Regression for the "project reverts on nav" bug (oss-366).
 *
 * Selecting a project in the sidebar switcher, then clicking any nav item,
 * must keep that project selected — the label stays, and every API request
 * carries the selected project's `x-koji-project` header so the data shown
 * is that project's, not the tenant default's.
 *
 * Self-provisions a second project + a distinctly-named schema (idempotent)
 * so it runs against the standard single-project seed. page.request shares
 * the authenticated storageState cookies.
 */
test("selected project survives navigation and scopes requests", async ({ page }) => {
  const tenantBase = await getTenantBase(page);
  const tenantSlug = tenantBase.split("/").pop()!;
  const h = { "x-koji-tenant": tenantSlug, "Content-Type": "application/json" };

  // Ensure a second project "side" with a schema unique to it (idempotent —
  // check before create so reruns against a persistent DB don't collide).
  const projects = await (await page.request.get("/api/projects", { headers: h })).json();
  if (!projects.data.some((p: { slug: string }) => p.slug === "side")) {
    const r = await page.request.post("/api/projects", {
      headers: h,
      data: { slug: "side", display_name: "Side Project" },
    });
    expect(r.ok()).toBeTruthy();
  }
  const sideHeaders = { ...h, "x-koji-project": "side" };
  const sideSchemas = await (
    await page.request.get("/api/schemas", { headers: sideHeaders })
  ).json();
  if (!sideSchemas.data.some((s: { slug: string }) => s.slug === "side_only_schema")) {
    const r = await page.request.post("/api/schemas", {
      headers: sideHeaders,
      data: { slug: "side_only_schema", display_name: "Side Only Schema" },
    });
    expect(r.ok()).toBeTruthy();
  }

  // Reload so the sidebar picks up the freshly-provisioned project list.
  await page.reload();

  // Open the project switcher (its trigger shows the current project name)
  // and pick "Side Project".
  await page.getByRole("button", { name: /Acme|acme/ }).first().click();
  await page.getByRole("menuitem", { name: "Side Project" }).click();
  await expect(page).toHaveURL(/\/projects\/side/);
  await expect(page.getByText("Side Project")).toBeVisible();

  // Navigate to a nav item whose URL has NO /projects/ segment — the exact
  // case that used to drop the selection — and assert the client still sends
  // the selected project's header.
  const schemasReq = page.waitForRequest(
    (r) => r.url().includes("/api/schemas") && r.method() === "GET",
  );
  await page.goto(`${tenantBase}/pipelines`);
  const req = await schemasReq;
  expect(req.headers()["x-koji-project"]).toBe("side");

  // No revert: the label still shows Side Project, and the sidebar's schema
  // list is the side project's.
  await expect(page.getByText("Side Project")).toBeVisible();
  await expect(page.getByText("side_only_schema")).toBeVisible();
});
