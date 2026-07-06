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
  | "audit:read"
  | "notification:read";

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
  "notification:read",
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

// ───────────────────────────────────────────────────────────────────────────
// Project roles (oss-372) — a member's capability WITHIN a single project.
//
// Distinct from the workspace roles above and mapped ONLY to project-scoped
// permissions: org-level powers (member:*, tenant:*, audit:read) are never
// granted per-project — they always come from the workspace role. See
// docs/per-project-roles.md.
// ───────────────────────────────────────────────────────────────────────────

export type ProjectRole =
  | "project-viewer"
  | "project-member"
  | "project-editor"
  | "project-admin";

const PROJECT_VIEWER_PERMS: Permission[] = [
  "schema:read",
  "job:read",
  "corpus:read",
  "pipeline:read",
  "trace:read",
  "review:read",
  "endpoint:read",
  "webhook:read",
  "notification:read",
];

const PROJECT_MEMBER_PERMS: Permission[] = [
  ...PROJECT_VIEWER_PERMS,
  "job:run",
  "playground:use",
  "review:act",
  "corpus:promote",
];

const PROJECT_EDITOR_PERMS: Permission[] = [
  ...PROJECT_MEMBER_PERMS,
  "schema:write",
  "schema:validate",
  "schema:benchmark",
  "schema:deploy",
  "corpus:write",
  "pipeline:write",
  "source:write",
  "endpoint:write",
  "webhook:write",
];

// project-admin adds the powerful/administrative project actions on top of
// editor — notably minting API keys (a programmatic credential bound to the
// project). Reserves room for delegated per-project access management later.
const PROJECT_ADMIN_PERMS: Permission[] = [...PROJECT_EDITOR_PERMS, "api_key:write"];

export const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<Permission>> = {
  "project-viewer": new Set(PROJECT_VIEWER_PERMS),
  "project-member": new Set(PROJECT_MEMBER_PERMS),
  "project-editor": new Set(PROJECT_EDITOR_PERMS),
  "project-admin": new Set(PROJECT_ADMIN_PERMS),
};

/** Least → most privileged, for ceiling checks when granting project roles. */
export const PROJECT_ROLE_RANK: ProjectRole[] = [
  "project-viewer",
  "project-member",
  "project-editor",
  "project-admin",
];

/**
 * The org-level permissions that a project role may NEVER carry — these always
 * derive from the workspace role. Used so a project-scoped request still gets
 * its org powers (if any) from the workspace role, while capability on the
 * project's own resources comes from the project role.
 */
export const ORG_LEVEL_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "member:read",
  "member:invite",
  "member:remove",
  "tenant:read",
  "tenant:admin",
  "tenant:delete",
  "tenant:transfer",
  "audit:read",
]);

/** Resolve project role(s) into their project-scoped permissions. */
export function resolveProjectPermissions(roles: string[]): Set<Permission> {
  const perms = new Set<Permission>();
  for (const role of roles) {
    const rolePerms = PROJECT_ROLE_PERMISSIONS[role as ProjectRole];
    if (rolePerms) for (const p of rolePerms) perms.add(p);
  }
  return perms;
}

export function isValidProjectRole(role: string): role is ProjectRole {
  return PROJECT_ROLE_RANK.includes(role as ProjectRole);
}

/**
 * Default-deny provisioning (oss-372): a NEW member starts project-restricted
 * (need-to-know) UNLESS they're an owner or tenant-admin — those administer the
 * workspace and retain visibility into every project. Existing members are
 * grandfathered (left unrestricted) at migration time, not here.
 */
export function shouldRestrictByDefault(roles: string[]): boolean {
  return !roles.includes("owner") && !roles.includes("tenant-admin");
}

export function highestProjectRoleRank(roles: string[]): number {
  let max = -1;
  for (const role of roles) {
    const idx = PROJECT_ROLE_RANK.indexOf(role as ProjectRole);
    if (idx > max) max = idx;
  }
  return max;
}

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
