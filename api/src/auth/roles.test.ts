import { describe, it, expect } from "vitest";
import {
  resolvePermissions,
  highestRoleRank,
  isValidRole,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  type Role,
} from "./roles";

describe("ROLE_PERMISSIONS", () => {
  it("defines exactly 7 roles", () => {
    expect(Object.keys(ROLE_PERMISSIONS)).toHaveLength(7);
  });

  it("viewer has only read permissions + audit:read", () => {
    const perms = ROLE_PERMISSIONS.viewer;
    for (const p of perms) {
      expect(p).toMatch(/:read$|^audit:read$/);
    }
  });

  it("each role is a superset of the one below it", () => {
    for (let i = 1; i < ROLE_RANK.length; i++) {
      const lower = ROLE_PERMISSIONS[ROLE_RANK[i - 1]!];
      const higher = ROLE_PERMISSIONS[ROLE_RANK[i]!];
      for (const perm of lower) {
        expect(higher.has(perm)).toBe(true);
      }
    }
  });

  it("owner has all permissions", () => {
    const owner = ROLE_PERMISSIONS.owner;
    // Collect every permission from all roles
    const all = new Set<string>();
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) all.add(p);
    }
    expect(owner.size).toBe(all.size);
  });

  it("runner can run jobs but not write schemas", () => {
    const perms = ROLE_PERMISSIONS.runner;
    expect(perms.has("job:run")).toBe(true);
    expect(perms.has("playground:use")).toBe(true);
    expect(perms.has("schema:write")).toBe(false);
  });

  it("schema-editor can write schemas but not deploy", () => {
    const perms = ROLE_PERMISSIONS["schema-editor"];
    expect(perms.has("schema:write")).toBe(true);
    expect(perms.has("schema:validate")).toBe(true);
    expect(perms.has("schema:deploy")).toBe(false);
  });

  it("schema-deployer can deploy but not admin", () => {
    const perms = ROLE_PERMISSIONS["schema-deployer"];
    expect(perms.has("schema:deploy")).toBe(true);
    expect(perms.has("pipeline:write")).toBe(true);
    expect(perms.has("tenant:admin")).toBe(false);
  });

  it("tenant-admin can invite/remove but not delete tenant", () => {
    const perms = ROLE_PERMISSIONS["tenant-admin"];
    expect(perms.has("member:invite")).toBe(true);
    expect(perms.has("member:remove")).toBe(true);
    expect(perms.has("tenant:admin")).toBe(true);
    expect(perms.has("tenant:delete")).toBe(false);
  });

  it("owner can delete and transfer tenant", () => {
    const perms = ROLE_PERMISSIONS.owner;
    expect(perms.has("tenant:delete")).toBe(true);
    expect(perms.has("tenant:transfer")).toBe(true);
  });
});

describe("resolvePermissions", () => {
  it("returns empty set for no roles", () => {
    expect(resolvePermissions([]).size).toBe(0);
  });

  it("returns empty set for invalid roles", () => {
    expect(resolvePermissions(["nonexistent"]).size).toBe(0);
  });

  it("resolves a single role", () => {
    const perms = resolvePermissions(["viewer"]);
    expect(perms.has("schema:read")).toBe(true);
    expect(perms.has("schema:write")).toBe(false);
  });

  it("union of multiple roles gives combined permissions", () => {
    // runner + schema-editor should give runner perms + editor perms
    const perms = resolvePermissions(["runner", "schema-editor"]);
    expect(perms.has("job:run")).toBe(true); // from runner
    expect(perms.has("schema:write")).toBe(true); // from schema-editor
    expect(perms.has("schema:deploy")).toBe(false); // neither has this
  });

  it("duplicate roles don't cause issues", () => {
    const perms = resolvePermissions(["viewer", "viewer"]);
    expect(perms.size).toBe(ROLE_PERMISSIONS.viewer.size);
  });

  it("mixed valid and invalid roles still resolve valid ones", () => {
    const perms = resolvePermissions(["viewer", "garbage"]);
    expect(perms.has("schema:read")).toBe(true);
    expect(perms.size).toBe(ROLE_PERMISSIONS.viewer.size);
  });
});

describe("highestRoleRank", () => {
  it("returns -1 for no roles", () => {
    expect(highestRoleRank([])).toBe(-1);
  });

  it("returns -1 for invalid roles", () => {
    expect(highestRoleRank(["bogus"])).toBe(-1);
  });

  it("returns correct rank for single role", () => {
    expect(highestRoleRank(["viewer"])).toBe(0);
    expect(highestRoleRank(["owner"])).toBe(6);
  });

  it("returns highest when multiple roles present", () => {
    expect(highestRoleRank(["viewer", "schema-editor"])).toBe(3);
    expect(highestRoleRank(["runner", "tenant-admin"])).toBe(5);
  });

  it("owner outranks all others", () => {
    for (const role of ROLE_RANK) {
      if (role !== "owner") {
        expect(highestRoleRank(["owner"])).toBeGreaterThan(
          highestRoleRank([role]),
        );
      }
    }
  });
});

describe("isValidRole", () => {
  it("accepts all 7 defined roles", () => {
    for (const role of ROLE_RANK) {
      expect(isValidRole(role)).toBe(true);
    }
  });

  it("rejects invalid strings", () => {
    expect(isValidRole("admin")).toBe(false);
    expect(isValidRole("superuser")).toBe(false);
    expect(isValidRole("")).toBe(false);
    expect(isValidRole("tenant-owner")).toBe(false); // old name
  });
});

describe("role ceiling (invite constraint)", () => {
  it("tenant-admin cannot invite owner", () => {
    const inviterMax = highestRoleRank(["tenant-admin"]);
    const inviteeMax = highestRoleRank(["owner"]);
    expect(inviteeMax).toBeGreaterThan(inviterMax);
  });

  it("schema-editor cannot invite tenant-admin", () => {
    const inviterMax = highestRoleRank(["schema-editor"]);
    const inviteeMax = highestRoleRank(["tenant-admin"]);
    expect(inviteeMax).toBeGreaterThan(inviterMax);
  });

  it("owner can invite any role", () => {
    const inviterMax = highestRoleRank(["owner"]);
    for (const role of ROLE_RANK) {
      const inviteeMax = highestRoleRank([role]);
      expect(inviteeMax).toBeLessThanOrEqual(inviterMax);
    }
  });

  it("same-rank invitation is allowed", () => {
    const inviterMax = highestRoleRank(["schema-editor"]);
    const inviteeMax = highestRoleRank(["schema-editor"]);
    expect(inviteeMax).toBeLessThanOrEqual(inviterMax);
  });
});
