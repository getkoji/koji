import { test, expect } from "@playwright/test";
import { getTenantBase } from "./helpers";

/**
 * oss-369: move a resource between projects, from the UI.
 *
 * Provisions a second project + a reference-free pipeline in the default
 * project (so the move isn't blocked), then drives the Move dialog on the
 * pipeline detail page and asserts the pipeline lands in the destination
 * project (visible there, gone from the default).
 */
test("moves a pipeline to another project via the UI", async ({ page }) => {
  const tenantBase = await getTenantBase(page);
  const tenantSlug = tenantBase.split("/").pop()!;
  const h = { "x-koji-tenant": tenantSlug, "Content-Type": "application/json" };

  // Second project.
  const projects = await (await page.request.get("/api/projects", { headers: h })).json();
  if (!projects.data.some((p: { slug: string }) => p.slug === "archive")) {
    expect((await page.request.post("/api/projects", { headers: h, data: { slug: "archive", display_name: "Archive" } })).ok()).toBeTruthy();
  }

  // A reference-free pipeline in the default project (no schema/endpoint pins),
  // idempotent so reruns against a persistent DB don't collide. If it was moved
  // to "archive" by an earlier run, move it back so this run starts clean.
  const listDefault = await (await page.request.get("/api/pipelines", { headers: h })).json();
  if (!listDefault.data.some((p: { slug: string }) => p.slug === "movable")) {
    const inArchiveNow = await (
      await page.request.get("/api/pipelines", { headers: { ...h, "x-koji-project": "archive" } })
    ).json();
    const movedRow = inArchiveNow.data.find((p: { slug: string; id: string }) => p.slug === "movable");
    if (movedRow) {
      await page.request.post(`/api/projects/${tenantSlug}/move`, {
        headers: h,
        data: { type: "pipeline", id: movedRow.id },
      });
    } else {
      const created = await page.request.post("/api/pipelines", {
        headers: h,
        data: { slug: "movable", name: "Movable Pipeline" },
      });
      expect(created.ok()).toBeTruthy();
    }
  }

  // Open the pipeline detail and move it.
  await page.goto(`${tenantBase}/pipelines/movable`);
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Move to another project" })).toBeVisible();
  // Pick the destination project (the only button carrying "Archive").
  await page.getByRole("button").filter({ hasText: "Archive" }).click();
  // Dry-run clears (no blockers) → the dialog's confirm Move enables. It's the
  // second "Move" button on the page (the first is the DangerZone trigger).
  const confirm = page.getByRole("button", { name: "Move", exact: true }).last();
  await expect(confirm).toBeEnabled({ timeout: 5000 });
  await confirm.click();

  // Redirected to the pipelines list; the pipeline is no longer in the default project.
  await expect(page).toHaveURL(/\/pipelines$/);
  await expect(page.getByText("movable")).toHaveCount(0);

  // It IS in the destination project.
  const inArchive = await (
    await page.request.get("/api/pipelines", { headers: { ...h, "x-koji-project": "archive" } })
  ).json();
  expect(inArchive.data.some((p: { slug: string }) => p.slug === "movable")).toBe(true);
});
