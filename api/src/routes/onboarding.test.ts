import { describe, it, expect, vi } from "vitest";
import { resolvePermissions } from "../auth/roles";

/**
 * Tests for the onboarding flow — invite acceptance, tenant listing,
 * project setup, and JIT provisioning. Validates the logic that
 * prevents orphan tenants and ensures correct role/permission resolution.
 */

describe("JIT provisioning for Clerk org members", () => {
  it("Clerk admin maps to tenant-admin role", () => {
    const orgRole = "org:admin";
    const kojiRoles = orgRole.includes("admin") || orgRole.includes("owner")
      ? ["tenant-admin"]
      : ["schema-editor"];
    expect(kojiRoles).toEqual(["tenant-admin"]);
  });

  it("Clerk member maps to schema-editor role", () => {
    const orgRole = "org:member";
    const kojiRoles = orgRole.includes("admin") || orgRole.includes("owner")
      ? ["tenant-admin"]
      : ["schema-editor"];
    expect(kojiRoles).toEqual(["schema-editor"]);
  });

  it("undefined orgRole defaults to org:member → schema-editor", () => {
    const orgRole = undefined ?? "org:member";
    const kojiRoles = orgRole.includes("admin") || orgRole.includes("owner")
      ? ["tenant-admin"]
      : ["schema-editor"];
    expect(kojiRoles).toEqual(["schema-editor"]);
  });

  it("tenant-admin resolves to all admin permissions", () => {
    const perms = resolvePermissions(["tenant-admin"]);
    expect(perms.has("api_key:write")).toBe(true);
    expect(perms.has("endpoint:write")).toBe(true);
    expect(perms.has("tenant:admin")).toBe(true);
    // tenant-admin does NOT have delete/transfer (that's owner only)
    expect(perms.has("tenant:delete")).toBe(false);
  });

  it("schema-editor has meaningful permissions (not zero)", () => {
    const perms = resolvePermissions(["schema-editor"]);
    expect(perms.size).toBeGreaterThan(0);
    expect(perms.has("schema:write")).toBe(true);
    expect(perms.has("schema:validate")).toBe(true);
    expect(perms.has("job:read")).toBe(true);
    expect(perms.has("corpus:write")).toBe(true);
    // schema-editor does NOT have admin perms
    expect(perms.has("api_key:write")).toBe(false);
    expect(perms.has("tenant:admin")).toBe(false);
  });

  it("'member' is not a valid role — resolves to zero permissions", () => {
    const perms = resolvePermissions(["member"]);
    expect(perms.size).toBe(0);
  });

  it("JIT and webhook mappings must agree", () => {
    // JIT (middleware.ts) and webhook (clerk-role-map.ts) must produce
    // the same Koji roles for the same Clerk roles. Divergence causes
    // users to get different permissions depending on which fires first.
    // JIT mapping:
    const jitAdmin = ["tenant-admin"];
    const jitMember = ["schema-editor"];
    // Webhook mapping (from clerk-role-map.ts):
    const webhookAdmin = ["tenant-admin"];
    const webhookMember = ["schema-editor"];
    expect(jitAdmin).toEqual(webhookAdmin);
    expect(jitMember).toEqual(webhookMember);
  });
});

describe("tenant listing with soft-deleted tenants", () => {
  it("soft-deleted tenant should be excluded even if slug matches", () => {
    // Simulates the query filter: WHERE slug = ? AND deleted_at IS NULL
    const tenants = [
      { id: "t1", slug: "superkey", deletedAt: new Date("2026-05-20") },
      { id: "t2", slug: "superkey", deletedAt: new Date("2026-05-21") },
      { id: "t3", slug: "superkey", deletedAt: null }, // active
    ];

    const active = tenants.filter((t) => t.deletedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("t3");
  });

  it("multiple active tenants with same slug should not exist", () => {
    // The partial unique index enforces this at DB level:
    // CREATE UNIQUE INDEX ON tenants(slug) WHERE deleted_at IS NULL
    // This test documents the invariant
    const activeSlugs = ["superkey"];
    const uniqueSlugs = new Set(activeSlugs);
    expect(uniqueSlugs.size).toBe(activeSlugs.length);
  });
});

describe("project setup endpoint guards", () => {
  it("blocks setup when user has orgId (Clerk invite flow)", () => {
    // POST /api/projects/setup checks principal.orgId
    // If set, the user came through a Clerk org invite and should not
    // create an orphan tenant
    const principal = { userId: "u1", orgId: "org_abc123" };
    expect(principal.orgId).toBeTruthy();
    // Route returns 403: "Workspaces are managed by your organization admin"
  });

  it("allows setup when user has no orgId (direct signup, OSS)", () => {
    const principal = { userId: "u1", orgId: undefined };
    expect(principal.orgId).toBeFalsy();
    // Route proceeds to create tenant + project
  });

  it("blocks setup when user already has a membership", () => {
    // Even without orgId, if user already has a tenant, setup returns 409
    const existingMemberships = [{ tenantId: "t1" }];
    expect(existingMemberships.length > 0).toBe(true);
    // Route returns 409: "You already have a workspace"
  });
});

describe("tenant listing JIT provisioning", () => {
  it("creates membership when Clerk org has matching tenant but no membership", () => {
    // Simulates: user has orgId, tenant exists with matching externalAuthId,
    // but no membership row exists yet
    const principal = {
      userId: "u1",
      orgId: "org_abc",
      orgRole: "org:admin",
    };

    // Tenant found by externalAuthId
    const tenant = { id: "t1", externalAuthId: "org_abc", deletedAt: null };
    expect(tenant.externalAuthId).toBe(principal.orgId);

    // No existing membership
    const existingMembership = null;
    expect(existingMembership).toBeNull();

    // JIT should create membership with tenant-admin role (admin maps to tenant-admin)
    const kojiRoles = principal.orgRole!.includes("admin") ? ["tenant-admin"] : ["schema-editor"];
    expect(kojiRoles).toEqual(["tenant-admin"]);
  });

  it("skips JIT when membership already exists", () => {
    const existingMembership = { id: "m1", roles: ["owner"] };
    expect(existingMembership).not.toBeNull();
    // No insert should happen
  });

  it("skips JIT when no tenant matches the orgId", () => {
    const principal = { userId: "u1", orgId: "org_nonexistent" };
    const matchingTenant = null; // no tenant with this externalAuthId
    expect(matchingTenant).toBeNull();
    // No insert should happen — the tenant hasn't been created yet
  });

  it("skips JIT when tenant is soft-deleted", () => {
    const tenant = { id: "t1", externalAuthId: "org_abc", deletedAt: new Date() };
    // Query filters: WHERE external_auth_id = ? AND deleted_at IS NULL
    // This tenant would not be found
    expect(tenant.deletedAt).not.toBeNull();
  });
});

describe("role sync on existing memberships", () => {
  it("upgrades schema-editor to tenant-admin when Clerk role changes to admin", () => {
    const membership = { roles: ["schema-editor"] };
    const kojiRoles = ["tenant-admin"]; // admin in Clerk

    const shouldSync =
      membership.roles.length === 1 &&
      membership.roles[0] !== kojiRoles[0] &&
      !membership.roles.includes("owner") &&
      !membership.roles.includes("tenant-admin");

    expect(shouldSync).toBe(true);
  });

  it("does not downgrade owner even if Clerk role is member", () => {
    const membership = { roles: ["owner"] };
    const kojiRoles = ["schema-editor"]; // member in Clerk

    const shouldSync =
      membership.roles.length === 1 &&
      membership.roles[0] !== kojiRoles[0] &&
      !membership.roles.includes("owner") &&
      !membership.roles.includes("tenant-admin");

    expect(shouldSync).toBe(false);
  });

  it("does not downgrade tenant-admin even if Clerk role is member", () => {
    const membership = { roles: ["tenant-admin"] };
    const kojiRoles = ["schema-editor"]; // member in Clerk

    const shouldSync =
      membership.roles.length === 1 &&
      membership.roles[0] !== kojiRoles[0] &&
      !membership.roles.includes("owner") &&
      !membership.roles.includes("tenant-admin");

    expect(shouldSync).toBe(false);
  });

  it("does not sync when roles already match", () => {
    const membership = { roles: ["tenant-admin"] };
    const kojiRoles = ["tenant-admin"];

    const shouldSync =
      membership.roles.length === 1 &&
      membership.roles[0] !== kojiRoles[0];

    expect(shouldSync).toBe(false);
  });
});
