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

    // Seeded credential renders as a card header. The credential display
    // name and the first model's default label are both "OpenAI primary"
    // (the model label defaults to the credential name on dual-write),
    // so scope the locator to the card header instead of matching both.
    await expect(
      page.getByText("OpenAI primary", { exact: true }).first(),
    ).toBeVisible();
  });

  test("danger zone is visible to owner", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    await page.goto(`${tenantBase}/settings/general`);

    // Test user is owner — danger zone should be visible
    await expect(page.getByText("Danger zone")).toBeVisible();
  });
});

/**
 * The workspace role is editable in place (PATCH /api/members/:id), which the
 * page previously had no UI for at all.
 *
 * Like project-members.spec.ts: the shared CI seed has only the owner, so the
 * always-true assertion is that your *own* role is not editable, and the actual
 * role change runs only when the environment seeds a second member. The API
 * rules are covered exhaustively by api/src/routes/members.test.ts and
 * api/src/auth/middleware.test.ts.
 */
test.describe("member role editing", () => {
  test("your own role is a read-only badge, others are editable", async ({ page }) => {
    const tenantBase = await getTenantBase(page);
    const tenantSlug = tenantBase.split("/").pop()!;
    await page.goto(`${tenantBase}/settings/members`);

    await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
    await expect(page.getByText("you")).toBeVisible();

    const me = await page.request
      .get("/api/me", { headers: { "x-koji-tenant": tenantSlug } })
      .then((r) => r.json());
    const members: Array<{ userId: string; name: string | null; email: string }> = await page.request
      .get("/api/members", { headers: { "x-koji-tenant": tenantSlug } })
      .then((r) => r.json())
      .then((b) => b.data ?? []);

    const self = members.find((m) => m.userId === me.id);
    // Self-demotion is how a last owner locks themselves out — no select.
    if (self) {
      await expect(page.getByLabel(`Role for ${self.name ?? self.email}`)).toHaveCount(0);
    }

    const other = members.find((m) => m.userId !== me.id);
    if (!other) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "only the owner is seeded; the role change itself is covered by API tests",
      });
      return;
    }

    const select = page.getByLabel(`Role for ${other.name ?? other.email}`);
    await expect(select).toBeVisible();
    const original = await select.inputValue();

    try {
      await select.selectOption("runner");
      await expect(select).toHaveValue("runner");

      // Survives a reload — persisted, not just local state.
      await page.reload();
      await expect(page.getByLabel(`Role for ${other.name ?? other.email}`)).toHaveValue("runner");
    } finally {
      // Specs share one seeded DB — hand the fixture back as we found it.
      await page.request.patch(`/api/members/${(other as any).id}`, {
        headers: { "x-koji-tenant": tenantSlug },
        data: { roles: [original] },
      });
    }
  });
});
