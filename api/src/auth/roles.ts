/**
 * RBAC role → permission map.
 *
 * Implements the 7 fixed roles from auth-permissioning.md §4.
 * Roles are additive and hierarchical: each role includes all
 * permissions of the roles below it.
 *
 * A user's effective permissions = union of ROLE_PERMISSIONS[role]
 * for each role in their memberships.roles array.
 */

export type Permission =
  | "schema:read"
  | "schema:write"
  | "schema:validate"
  | "schema:benchmark"
  | "schema:deploy"
  | "job:read"
  | "job:run"
  | "corpus:read"
  | "corpus:write"
  | "corpus:promote"
  | "pipeline:read"
  | "pipeline:write"
  | "trace:read"
  | "review:read"
  | "review:act"
  | "endpoint:read"
  | "endpoint:write"
  | "webhook:read"
  | "webhook:write"
  | "member:read"
  | "member:invite"
  | "member:remove"
  | "tenant:read"
  | "tenant:admin"
  | "tenant:delete"
  | "tenant:transfer"
  | "api_key:write"
  | "source:write"
  | "playground:use"
  | "audit:read";

export type Role =
  | "viewer"
  | "runner"
  | "reviewer"
  | "schema-editor"
  | "schema-deployer"
  | "tenant-admin"
  | "owner";

const VIEWER_PERMS: Permission[] = [
  "schema:read",
  "job:read",
  "corpus:read",
  "pipeline:read",
  "trace:read",
  "review:read",
  "endpoint:read",
  "webhook:read",
  "member:read",
  "tenant:read",
  "audit:read",
];

const RUNNER_PERMS: Permission[] = [...VIEWER_PERMS, "job:run", "playground:use"];

const REVIEWER_PERMS: Permission[] = [...RUNNER_PERMS, "review:act", "corpus:promote"];

const SCHEMA_EDITOR_PERMS: Permission[] = [
  ...REVIEWER_PERMS,
  "schema:write",
  "schema:validate",
  "schema:benchmark",
  "corpus:write",
];

const SCHEMA_DEPLOYER_PERMS: Permission[] = [
  ...SCHEMA_EDITOR_PERMS,
  "schema:deploy",
  "pipeline:write",
];

const TENANT_ADMIN_PERMS: Permission[] = [
  ...SCHEMA_DEPLOYER_PERMS,
  "tenant:admin",
  "api_key:write",
  "member:invite",
  "member:remove",
  "endpoint:write",
  "webhook:write",
  "source:write",
];

const OWNER_PERMS: Permission[] = [
  ...TENANT_ADMIN_PERMS,
  "tenant:delete",
  "tenant:transfer",
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER_PERMS),
  runner: new Set(RUNNER_PERMS),
  reviewer: new Set(REVIEWER_PERMS),
  "schema-editor": new Set(SCHEMA_EDITOR_PERMS),
  "schema-deployer": new Set(SCHEMA_DEPLOYER_PERMS),
  "tenant-admin": new Set(TENANT_ADMIN_PERMS),
  owner: new Set(OWNER_PERMS),
};

/** Ordered from least to most privileged — used for role ceiling checks on invites. */
export const ROLE_RANK: Role[] = [
  "viewer",
  "runner",
  "reviewer",
  "schema-editor",
  "schema-deployer",
  "tenant-admin",
  "owner",
];

/**
 * Resolve a set of roles into the union of their permissions.
 */
export function resolvePermissions(roles: string[]): Set<Permission> {
  const perms = new Set<Permission>();
  for (const role of roles) {
    const rolePerms = ROLE_PERMISSIONS[role as Role];
    if (rolePerms) {
      for (const p of rolePerms) perms.add(p);
    }
  }
  return perms;
}

/**
 * Get the highest role rank from an array of roles.
 * Returns -1 if no valid roles.
 */
export function highestRoleRank(roles: string[]): number {
  let max = -1;
  for (const role of roles) {
    const idx = ROLE_RANK.indexOf(role as Role);
    if (idx > max) max = idx;
  }
  return max;
}

/**
 * Check if a role string is a valid Role.
 */
export function isValidRole(role: string): role is Role {
  return ROLE_RANK.includes(role as Role);
}
