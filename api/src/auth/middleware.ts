/**
 * Auth middleware — 5-stage request lifecycle:
 *
 * 1. Identify — resolve principal from session cookie or Bearer token
 * 2. Resolve tenant — from x-koji-tenant header
 * 3. Load grants — look up membership, expand roles → permissions
 * 4. Set context — principal, tenantId, grants on Hono context
 * 5. Enforce — requires() middleware checks permissions per route
 *
 * Public routes skip all of this. Authenticated-but-no-tenant routes
 * (like /api/me, /api/tenants) skip tenant resolution.
 */
import { createHash, createHmac } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { eq, and, isNull, sql } from "drizzle-orm";
import { schema } from "@koji/db";
import type { AuthAdapter, Principal } from "./adapter";
import { resolvePermissions, resolveProjectPermissions, shouldRestrictByDefault, ORG_LEVEL_PERMISSIONS, type Permission } from "./roles";
import type { Env } from "../env";

const DEFAULT_SESSION_COOKIE = "koji_session";

/**
 * How stale `api_keys.last_used_at` is allowed to get before a request
 * refreshes it. The column exists to answer "is this key still in use?" —
 * rotation and offboarding decisions, and spotting a key nobody owns any
 * more. Minute-level precision is ample for that, and throttling keeps a
 * high-volume key from adding a row update to every single request.
 */
const API_KEY_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Stamp `last_used_at` on the key that just authenticated (oss-496).
 *
 * The column was read by GET /api/api-keys and rendered in the dashboard as
 * "used <time ago>", but nothing ever wrote it — so it was NULL on every key
 * ever issued, including ones driving tens of thousands of jobs a month.
 *
 * Two details worth keeping:
 *  - The write is throttled on the value we already selected, so the common
 *    case costs nothing beyond the comparison.
 *  - The UPDATE re-checks staleness in SQL rather than trusting that read.
 *    Concurrent requests all observe the same stale timestamp and would
 *    otherwise each issue a write; the predicate means only the first one
 *    matches a row.
 *
 * Failures are swallowed: a telemetry column must never turn a valid API key
 * into a failed request.
 */
async function touchApiKeyLastUsed(
  db: Env["Variables"]["db"],
  apiKeyId: string,
  lastUsedAt: Date | null,
): Promise<void> {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < API_KEY_LAST_USED_THROTTLE_MS) {
    return;
  }
  const staleBefore = new Date(Date.now() - API_KEY_LAST_USED_THROTTLE_MS);
  try {
    await db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, apiKeyId),
          sql`(${schema.apiKeys.lastUsedAt} IS NULL OR ${schema.apiKeys.lastUsedAt} < ${staleBefore})`,
        ),
      );
  } catch (err) {
    console.warn(
      `[auth] failed to stamp last_used_at for api key ${apiKeyId}:`,
      (err as Error).message,
    );
  }
}

/**
 * A syntactically-valid project id that can never match a real project (the
 * nil UUID). Used as the resolved project for a restricted member who has NO
 * accessible project, so project-scoped tables return zero rows instead of
 * falling through to tenant-wide access. Real project ids are gen_random_uuid
 * (v4), never all-zero.
 */
const NO_PROJECT_SENTINEL = "00000000-0000-0000-0000-000000000000";

export interface AuthMiddlewareOptions {
  /** Cookie name the middleware should pull a bearer token from. Defaults to
   *  `koji_session` (the local adapter). Hosted/Clerk sets `__session` on the
   *  app domain, so the platform Worker configures that here.
   *  Authorization: Bearer tokens are always honoured as a fallback. */
  sessionCookie?: string;
}

/** Routes that skip auth entirely. */
const PUBLIC_PATHS = new Set([
  "/health",
  "/health/ready",
  "/api/health",
  "/api/setup/status",
  "/api/setup",
  "/api/auth/login",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/invites/accept",
  "/api/inngest",
  "/api/billing/webhooks/stripe",
  "/api/webhooks/clerk",
  "/api/model-registry/refresh",
]);

/** Routes that require auth but not tenant context. */
const NO_TENANT_PATHS = new Set([
  "/api/me",
  "/api/me/password",
  "/api/me/can-delete",
  "/api/tenants",
]);

function matchesNoTenantPath(path: string): boolean {
  // Exact matches or prefix matches for paths with sub-routes
  if (NO_TENANT_PATHS.has(path)) return true;
  if (path === "/api/me" || path.startsWith("/api/me/")) return true;
  if (path === "/api/tenants" || path.startsWith("/api/tenants/")) return true;
  if (path === "/api/cli/authorize") return true;
  if (path === "/api/projects/setup") return true;
  if (path === "/api/model-registry") return true;
  if (path === "/api/model-registry/refresh") return true;
  if (path.startsWith("/api/admin")) return true;
  return false;
}

export function authMiddleware(adapter: AuthAdapter, opts: AuthMiddlewareOptions = {}) {
  const sessionCookie = opts.sessionCookie ?? DEFAULT_SESSION_COOKIE;

  return async (c: Context<Env>, next: Next) => {
    const path = c.req.path;

    // Public routes — no auth needed
    if (PUBLIC_PATHS.has(path)) {
      await next();
      return;
    }

    // Source webhook inbound — public, verified by HMAC, not user auth
    if (path.match(/^\/api\/sources\/[^/]+\/webhook$/)) {
      await next();
      return;
    }

    // Document preview / embed / stream — these endpoints accept either
    // a session cookie (normal dashboard user) OR a time-limited HMAC
    // preview token (embed viewer, external iframe). The handlers
    // themselves are dual-auth aware: if `tenantId` is set they use
    // RLS, otherwise they fall back to a raw-DB read gated by the token.
    //
    // Auth rules here:
    //   - Token present + valid    → bypass session auth, set next().
    //   - Token present + invalid  → 403 with "expired token" so the
    //     embed viewer can re-fetch a fresh token instead of silently
    //     prompting for login.
    //   - Token absent             → fall through to the normal
    //     session-cookie auth path below. (Previously this returned
    //     403 too, which 403'd every cookie-authenticated dashboard
    //     hit on /stream — the bug we're fixing here.)
    const docEndpointMatch = path.match(/^(\/api\/jobs\/[^/]+\/documents\/[^/]+)\/(preview|embed-data|stream|resolve-region)$/);
    if (docEndpointMatch) {
      const basePath = docEndpointMatch[1]!;
      const masterKey = c.get("masterKey") as string | null;
      if (!masterKey) {
        await next();
        return;
      }
      const previewToken = c.req.query("token");
      if (previewToken) {
        if (verifyPreviewToken(previewToken, basePath, masterKey)) {
          await next();
          return;
        }
        return c.json({ error: "Invalid or expired preview token" }, 403);
      }
      // No token → fall through to the session-cookie / bearer auth
      // path below. The handler at jobs.ts checks `tenantId` to know
      // which read path to use.
    }

    // --- Stage 1: Identify ---
    const cookieToken = getCookie(c, sessionCookie);
    const bearerToken = c.req.header("Authorization")?.replace("Bearer ", "");
    const token = cookieToken || bearerToken;

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Use the per-request auth adapter from context if available (Workers
    // injects a fresh one with a per-request DB), falling back to the
    // closure adapter for Node/self-hosted where the DB is shared.
    const requestAuth = c.get("auth") ?? adapter;
    let principal = await requestAuth.resolve(token);

    // Fallback: if the adapter didn't resolve the token and it looks like
    // a CLI API key (koji_ prefix), check the api_keys table directly.
    // This works across all auth adapters (local, Clerk, OIDC).
    if (!principal && token.startsWith("koji_") && !token.startsWith("koji_sess_")) {
      const db = c.get("db");
      const keyHashHex = createHash("sha256").update(token).digest("hex");
      const [row] = await db
        .select({
          id: schema.apiKeys.id,
          tenantId: schema.apiKeys.tenantId,
          projectId: schema.apiKeys.projectId,
          userId: schema.apiKeys.createdBy,
          email: schema.users.email,
          name: schema.users.name,
          lastUsedAt: schema.apiKeys.lastUsedAt,
        })
        .from(schema.apiKeys)
        .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.createdBy))
        .where(
          and(
            sql`${schema.apiKeys.keyHash} = decode(${keyHashHex}, 'hex')`,
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .limit(1);

      if (row) {
        principal = {
          userId: row.userId,
          email: row.email,
          name: row.name,
        };
        // Stash the tenant + project + id from the key so tenant/project
        // resolution can use them when no headers are present. projectId is
        // null for an all-access key; the id resolves the multi-project grants.
        c.set("apiKeyTenantId", row.tenantId);
        c.set("apiKeyProjectId", row.projectId ?? undefined);
        c.set("apiKeyId", row.id);

        await touchApiKeyLastUsed(db, row.id, row.lastUsedAt);
      }
    }

    if (!principal) {
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    c.set("principal", principal);

    // Routes that don't need tenant context
    if (matchesNoTenantPath(path)) {
      await next();
      return;
    }

    // --- Stage 2: Resolve tenant ---
    const tenantSlug = c.req.header("x-koji-tenant");
    const db = c.get("db");
    let tenant: { id: string } | undefined;

    // API keys carry their tenant — use it when no header/org is provided
    const apiKeyTenantId = c.get("apiKeyTenantId") as string | undefined;

    if (tenantSlug) {
      // Primary path: resolve by slug (OSS, CLI, API keys)
      [tenant] = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(and(eq(schema.tenants.slug, tenantSlug), isNull(schema.tenants.deletedAt)))
        .limit(1);
    } else if (principal.orgId) {
      // Org-based path: resolve by external auth ID (Clerk org, OIDC group, etc.)
      [tenant] = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(and(eq(schema.tenants.externalAuthId, principal.orgId), isNull(schema.tenants.deletedAt)))
        .limit(1);
    } else if (apiKeyTenantId) {
      // API key path: tenant is embedded in the key row
      tenant = { id: apiKeyTenantId };
    }

    if (!tenant) {
      if (!tenantSlug && !principal.orgId && !apiKeyTenantId) {
        return c.json({ error: "Missing x-koji-tenant header" }, 400);
      }
      return c.json({ error: "Tenant not found" }, 404);
    }

    // An API key is a credential FOR its tenant — a header naming a different
    // tenant must not widen it, even when the key's creator is a member of
    // that other tenant. (Session/org auth is unaffected.)
    if (apiKeyTenantId && tenant.id !== apiKeyTenantId) {
      return c.json({ error: "API key is not valid for this workspace" }, 403);
    }

    c.set("tenantId", tenant.id);

    // --- Stage 2.5: Resolve project ---
    // Projects are the intra-tenant isolation boundary. Resolution:
    //   1. x-koji-project header — session auth may name any live project in
    //      the tenant; API-key auth may only name the key's own project (the
    //      binding is a boundary, not a default).
    //   2. the API key's bound project (checked to still be live).
    //   3. the tenant's default project (slug matches the tenant slug,
    //      falling back to the oldest live project).
    // The resolved id rides into withRLS via getRlsScope(c), where the
    // RESTRICTIVE project policies narrow every project-scoped table.
    //
    // A header naming an unknown project is answered only AFTER the
    // membership check below — answering here would let any authenticated
    // non-member probe which project slugs exist in a tenant.
    const projectSlug = c.req.header("x-koji-project");
    const apiKeyProjectId = c.get("apiKeyProjectId") as string | undefined;
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    const isApiKey = !!apiKeyTenantId;
    let projectNotFound = false;
    let projectForbidden = false;

    // The set of projects the caller may reach. `null` = unrestricted (every
    // project in the tenant); a Set = limited to exactly those projects.
    // Members (oss-370) and API keys (oss-433) share this machinery.
    let accessibleProjectIds: Set<string> | null = null;
    // For a restricted member, the per-project role(s) keyed by project id —
    // used in Stage 3 to compute project-scoped capability (oss-372).
    let projectRolesByProject: Map<string, string[]> | null = null;
    // A key's preferred default project (its `project_id`) when no
    // x-koji-project header is sent — only used if it's still an accessible,
    // live project. undefined ⇒ fall back to the tenant default.
    let keyDefaultProject: string | undefined;

    if (isApiKey) {
      // An API key's project scope mirrors the member `projectRestricted`
      // model (see `api_keys.project_id`):
      //   - grant rows present         → multi-project: allowed = the grants.
      //   - no grants, project_id set  → single-project: allowed = {project_id}.
      //   - no grants, project_id null → all-access: unrestricted (null).
      const grants = apiKeyId
        ? await db
            .select({ projectId: schema.apiKeyProjectAccess.projectId })
            .from(schema.apiKeyProjectAccess)
            .where(
              and(
                eq(schema.apiKeyProjectAccess.tenantId, tenant.id),
                eq(schema.apiKeyProjectAccess.apiKeyId, apiKeyId),
              ),
            )
        : [];
      if (grants.length > 0) {
        accessibleProjectIds = new Set(grants.map((g) => g.projectId));
        keyDefaultProject =
          apiKeyProjectId && accessibleProjectIds.has(apiKeyProjectId) ? apiKeyProjectId : undefined;
      } else if (apiKeyProjectId) {
        accessibleProjectIds = new Set([apiKeyProjectId]);
        keyDefaultProject = apiKeyProjectId;
      } else {
        accessibleProjectIds = null; // all-access
      }
    } else {
      const [m] = await db
        .select({ restricted: schema.memberships.projectRestricted })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, principal.userId),
            eq(schema.memberships.tenantId, tenant.id),
          ),
        )
        .limit(1);
      if (m?.restricted) {
        const grants = await db
          .select({ projectId: schema.projectAccess.projectId, roles: schema.projectAccess.roles })
          .from(schema.projectAccess)
          .where(
            and(
              eq(schema.projectAccess.tenantId, tenant.id),
              eq(schema.projectAccess.userId, principal.userId),
            ),
          );
        accessibleProjectIds = new Set(grants.map((g) => g.projectId));
        projectRolesByProject = new Map(grants.map((g) => [g.projectId, g.roles]));
      }
    }
    const canAccessProject = (id: string) =>
      accessibleProjectIds === null || accessibleProjectIds.has(id);
    // Expose to routes (e.g. GET /api/projects filters the switcher to the
    // projects the caller can actually reach). null = unrestricted.
    c.set("accessibleProjectIds", accessibleProjectIds);

    if (projectSlug) {
      const [project] = await db
        .select({ id: schema.projects.id, slug: schema.projects.slug })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.tenantId, tenant.id),
            eq(schema.projects.slug, projectSlug),
            isNull(schema.projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project) {
        projectNotFound = true;
      } else if (!canAccessProject(project.id)) {
        // The caller can't reach this project, but the project DOES exist and
        // belongs to the caller's own tenant — a tenant the caller is already
        // authenticated for. Answering 404 here (the old behavior for API keys)
        // was indistinguishable from a typo'd slug, and the most common way to
        // hit it is your own key being narrower than you remember. Say so.
        //
        // The anti-probing concern this replaces was intra-tenant only: cross
        // tenants are still answered by the `!project` branch above, which
        // never reveals another tenant's slugs.
        projectForbidden = true;
      } else {
        c.set("projectId", project.id);
        setResolvedProject(c, project.slug);
      }
    } else {
      // No x-koji-project header — pick a default project the caller can
      // access. Preference: the key's own default project, then the tenant
      // default (slug matches the tenant slug), then the oldest live project.
      const candidates = await db
        .select({ id: schema.projects.id, slug: schema.projects.slug })
        .from(schema.projects)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.projects.tenantId))
        .where(and(eq(schema.projects.tenantId, tenant.id), isNull(schema.projects.deletedAt)))
        .orderBy(
          sql`(${schema.projects.id} = ${keyDefaultProject ?? NO_PROJECT_SENTINEL}) DESC`,
          sql`(${schema.projects.slug} = ${schema.tenants.slug}) DESC`,
          schema.projects.createdAt,
          schema.projects.id,
        );
      const project = candidates.find((p) => canAccessProject(p.id));
      if (project) {
        c.set("projectId", project.id);
        setResolvedProject(c, project.slug);
      } else if (isApiKey && accessibleProjectIds !== null) {
        // A single-/multi-project key whose entire accessible set is gone (e.g.
        // its only bound project was soft-deleted). The key is scoped to
        // projects that no longer exist — refuse rather than silently widening
        // it to tenant-wide.
        return c.json({ error: "The project this API key belongs to has been deleted" }, 403);
      } else if (accessibleProjectIds !== null) {
        // A restricted member with NO accessible project must NOT fall through
        // to tenant-wide scope (which would expose every project's data via
        // the RESTRICTIVE policy's "no project set" arm). Pin an impossible
        // project id so project-scoped tables return zero rows, while
        // tenant-level routes (no project policy) still work.
        c.set("projectId", NO_PROJECT_SENTINEL);
      }
      // else: unrestricted (all-access key or unrestricted member) + tenant
      // with zero live projects (mid-setup) → leave unset; tenant-wide is
      // correct until the default project exists.
    }

    // --- Stage 3: Load grants ---
    let [membership] = await db
      .select({ roles: schema.memberships.roles })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, principal.userId),
          eq(schema.memberships.tenantId, tenant.id),
        ),
      )
      .limit(1);

    // JIT provisioning + role sync for Clerk org members.
    // When a user is in a Clerk org but has no Koji membership, create one.
    // When they have one, sync roles from Clerk in case the org role changed.
    if (principal.orgId) {
      const orgRole = principal.orgRole ?? "org:member";
      const kojiRoles = orgRole.includes("admin") || orgRole.includes("owner")
        ? ["tenant-admin"]
        : ["schema-editor"];

      if (!membership) {
        try {
          await db.insert(schema.memberships).values({
            userId: principal.userId,
            tenantId: tenant.id,
            roles: kojiRoles,
            // Default-deny for JIT-provisioned org members that aren't admins.
            projectRestricted: shouldRestrictByDefault(kojiRoles),
          });
          membership = { roles: kojiRoles };
          console.log(`[auth] JIT provisioned membership for user ${principal.userId} in tenant ${tenant.id} (roles: ${kojiRoles})`);
        } catch (err: any) {
          // Unique constraint = race condition, re-read
          if (err.code === "23505") {
            [membership] = await db
              .select({ roles: schema.memberships.roles })
              .from(schema.memberships)
              .where(and(
                eq(schema.memberships.userId, principal.userId),
                eq(schema.memberships.tenantId, tenant.id),
              ))
              .limit(1);
          }
        }
      } else if (
        membership.roles.length === 1 &&
        membership.roles[0] !== kojiRoles[0] &&
        !membership.roles.includes("owner") && !membership.roles.includes("tenant-admin") // don't downgrade admins/owners
      ) {
        // Sync: Clerk role changed since last JIT provision. Re-evaluate
        // default-deny too — demoting an org admin to a regular member must
        // make them need-to-know (else they'd keep tenant-wide PII visibility).
        await db
          .update(schema.memberships)
          .set({
            roles: kojiRoles,
            projectRestricted: shouldRestrictByDefault(kojiRoles),
            updatedAt: new Date(),
          })
          .where(and(
            eq(schema.memberships.userId, principal.userId),
            eq(schema.memberships.tenantId, tenant.id),
          ));
        membership = { roles: kojiRoles };
        console.log(`[auth] Synced membership roles for user ${principal.userId} in tenant ${tenant.id} (roles: ${kojiRoles})`);
      }
    }

    if (!membership) {
      return c.json({ error: "You are not a member of this workspace" }, 403);
    }

    // Deferred from Stage 2.5 — answered only after the membership check, so
    // a non-member can't use the response to discover a tenant's projects.
    if (projectNotFound) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (projectForbidden) {
      return c.json(
        {
          error: isApiKey
            ? "This API key is not scoped to that project. Update the key's project access, or use a key with workspace-wide access."
            : "You do not have access to this project",
        },
        403,
      );
    }

    // --- Grants ---
    // Unrestricted member (owner/admin/grandfathered): full workspace-role
    // permissions everywhere. Restricted member (oss-372): org-level powers
    // still come from the workspace role, but capability on the resolved
    // project's resources comes from the PROJECT role — so a member's project
    // role, not their workspace role, is the ceiling within a project. Org and
    // project permission sets are disjoint, so the union is unambiguous:
    // org-level routes read the org powers, project-scoped routes read the
    // project-role powers.
    //
    // An API key (oss-433) is NOT subject to the project-role narrowing even
    // when it is multi/single-project-scoped: its project *set* limits which
    // projects it can reach (enforced via the resolved projectId + RLS), not
    // its capability. A key acts with its creator's full role permissions.
    let grants: Set<Permission>;
    if (accessibleProjectIds === null || isApiKey) {
      grants = resolvePermissions(membership.roles);
    } else {
      grants = new Set<Permission>();
      for (const p of resolvePermissions(membership.roles)) {
        if (ORG_LEVEL_PERMISSIONS.has(p)) grants.add(p);
      }
      const resolvedProject = c.get("projectId") as string | undefined;
      const projectRoles = resolvedProject ? projectRolesByProject?.get(resolvedProject) : undefined;
      if (projectRoles) {
        for (const p of resolveProjectPermissions(projectRoles)) grants.add(p);
      }
    }
    c.set("grants", grants);
    c.set("roles", membership.roles);

    await next();
  };
}

/**
 * Route-level permission guard.
 *
 * Usage:
 *   router.get('/schemas', requires('schema:read'), listSchemas);
 *   router.post('/schemas', requires('schema:write'), createSchema);
 *
 * Multiple permissions = OR (any one is sufficient).
 */
export function requires(...permissions: Permission[]) {
  return async (c: Context<Env>, next: Next) => {
    const grants = c.get("grants") as Set<Permission> | undefined;

    if (!grants) {
      return c.json({ code: "forbidden", message: "No permissions resolved" }, 403);
    }

    const hasAny = permissions.some((p) => grants.has(p));
    if (!hasAny) {
      return c.json(
        { code: "forbidden", message: `Missing permission: ${permissions.join(" | ")}` },
        403,
      );
    }

    await next();
  };
}

/** Get the principal from the request context. Throws if not set. */
export function getPrincipal(c: Context<Env>): Principal {
  const p = c.get("principal");
  if (!p) throw new Error("No principal on context — auth middleware not applied?");
  return p;
}

/** Get the resolved tenant ID. Throws if not set. */
/**
 * The project scope is decided here, from three sources a client can't see: an
 * `x-koji-project` header, an API key's own binding, or a default pick. A CLI
 * that guesses wrong writes to the wrong project silently — `koji push`
 * creating a duplicate classifier in a project the operator wasn't looking at,
 * `koji pull` writing a different project's schemas. So every authenticated
 * response says which project actually answered it (oss-491).
 */
export const RESOLVED_PROJECT_HEADER = "x-koji-project-resolved";

function setResolvedProject(c: Context<Env>, slug: string | undefined): void {
  if (!slug) return;
  c.set("projectSlug", slug);
  c.header(RESOLVED_PROJECT_HEADER, slug);
}

/** The slug of the project this request resolved to, when it resolved to one. */
export function getProjectSlug(c: Context<Env>): string | null {
  return (c.get("projectSlug") as string | undefined) ?? null;
}

export function getTenantId(c: Context<Env>): string {
  const id = c.get("tenantId");
  if (!id) throw new Error("No tenantId on context — tenant resolution not applied?");
  return id;
}

/** Get the resolved project ID, or null when the request is tenant-wide
 *  (no header, no key binding, tenant has no projects yet). */
export function getProjectId(c: Context<Env>): string | null {
  return (c.get("projectId") as string | undefined) ?? null;
}

/** The set of project IDs the current member may access, or null when
 *  unrestricted (all projects). */
export function getAccessibleProjectIds(c: Context<Env>): Set<string> | null {
  return (c.get("accessibleProjectIds") as Set<string> | null | undefined) ?? null;
}

/**
 * The RLS scope for the current request — pass this to `withRLS` so
 * project-scoped tables are narrowed to the resolved project. Handlers that
 * genuinely need tenant-wide access (none today) should pass a bare tenantId
 * instead, with a comment saying why.
 */
export function getRlsScope(c: Context<Env>): { tenantId: string; projectId: string | null } {
  return { tenantId: getTenantId(c), projectId: getProjectId(c) };
}

/**
 * Like getProjectId but for write paths that create project-scoped rows —
 * a request that resolved no project cannot create resources (only possible
 * for a tenant with zero projects, i.e. mid-setup).
 */
export function requireProjectId(c: Context<Env>): string {
  const id = getProjectId(c);
  if (!id) {
    throw new HTTPException(400, {
      message: "No project resolved — create a project before creating resources",
    });
  }
  return id;
}

/** Get the user's roles for the current tenant. */
export function getRoles(c: Context<Env>): string[] {
  return (c.get("roles") as string[] | undefined) ?? [];
}

/** Get the user's resolved permissions for the current tenant. */
export function getGrants(c: Context<Env>): Set<Permission> {
  return (c.get("grants") as Set<Permission> | undefined) ?? new Set();
}

// ---------------------------------------------------------------------------
// Preview token — HMAC-signed, time-limited access to document preview URLs.
// Format: "<expiry_epoch_seconds_hex>.<hmac_hex>"
// HMAC = sha256(path + ":" + expiry_hex, masterKey)
// ---------------------------------------------------------------------------

const PREVIEW_TOKEN_TTL_SECONDS = 3600; // 1 hour

/** Generate a signed preview token for a document preview URL path. */
export function generatePreviewToken(path: string, masterKey: string): string {
  const expiry = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS;
  const expiryHex = expiry.toString(16);
  const mac = createHmac("sha256", masterKey)
    .update(`${path}:${expiryHex}`)
    .digest("hex");
  return `${expiryHex}.${mac}`;
}

/** Verify a preview token. Returns true if valid and not expired. */
function verifyPreviewToken(token: string, path: string, masterKey: string | null): boolean {
  if (!masterKey) return false;

  const dotIdx = token.indexOf(".");
  if (dotIdx < 1) return false;

  const expiryHex = token.slice(0, dotIdx);
  const providedMac = token.slice(dotIdx + 1);

  const expiry = parseInt(expiryHex, 16);
  if (Number.isNaN(expiry) || expiry < Math.floor(Date.now() / 1000)) {
    return false; // expired or invalid
  }

  const expectedMac = createHmac("sha256", masterKey)
    .update(`${path}:${expiryHex}`)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  if (providedMac.length !== expectedMac.length) return false;
  const a = Buffer.from(providedMac, "hex");
  const b = Buffer.from(expectedMac, "hex");
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
