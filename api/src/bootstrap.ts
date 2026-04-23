/**
 * Bootstrap — runs on API server startup.
 *
 * 1. Applies DB migrations (Drizzle + RLS)
 * 2. Creates the default tenant if it doesn't exist
 * 3. Creates a default admin user if it doesn't exist
 *
 * The default tenant is used for single-tenant / self-hosted installs.
 * Multi-tenant (hosted) will resolve tenants from auth instead.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@koji/db";
import { schema } from "@koji/db";

export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

export async function bootstrap(db: Db): Promise<void> {
  // Check if default tenant exists (query without RLS — bootstrap runs as superuser)
  const existing = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(sql`id = ${DEFAULT_TENANT_ID}::uuid`)
    .limit(1);

  if (existing.length > 0) {
    console.log("[koji-api] Default tenant exists, skipping bootstrap");
    return;
  }

  console.log("[koji-api] Creating default tenant + admin user...");

  // Create default tenant
  await db.insert(schema.tenants).values({
    id: DEFAULT_TENANT_ID,
    slug: "default",
    displayName: "Default Tenant",
    plan: "scale",
  });

  // Create default admin user
  await db.insert(schema.users).values({
    id: DEFAULT_USER_ID,
    email: "admin@localhost",
    name: "Admin",
    authProvider: "local",
    authProviderId: "local-admin",
  });

  // Create membership
  await db.insert(schema.memberships).values({
    userId: DEFAULT_USER_ID,
    tenantId: DEFAULT_TENANT_ID,
    roles: ["tenant-owner", "project-admin", "schema-write", "pipeline-write"],
  });

  console.log("[koji-api] Bootstrap complete — default tenant + admin created");
}
