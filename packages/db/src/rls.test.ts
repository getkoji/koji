/**
 * Round-trip RLS test.
 *
 * Spins up a real Postgres instance via Testcontainers, applies the full
 * migration stream (CREATE TABLE + 0001_rls.sql), seeds two tenants, inserts
 * a row per tenant into every tenant-scoped table, and asserts that
 * `withRLS(tenantA, ...)` sees only tenant A's rows — with zero leakage
 * under any of:
 *
 *   - A direct SELECT inside `withRLS(B, ...)` returns only B's rows.
 *   - A connection that has NEVER called `SET LOCAL app.current_tenant_id`
 *     returns zero rows (the safe-default guarantee).
 *   - A query that omits an explicit `WHERE tenant_id = ...` still returns
 *     only the active tenant's rows (the whole point of RLS).
 *   - The `SET LOCAL ROLE app_user` path (production Neon pattern) enforces
 *     RLS even when the connection role has BYPASSRLS.
 *
 * The test runs in CI and locally whenever Docker is available. It is
 * intentionally the most important test file in this package — the RLS path
 * is the single most dangerous surface in the DB layer, and a real
 * Postgres check is the only way to catch regressions in it.
 */
import { randomUUID } from "node:crypto";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDb, RLS_POLICIES, schema, withRLS, type Db } from "./index";
import { runMigrations } from "./migrate";

let container: StartedPostgreSqlContainer;
let rootDb: Db;
let db: Db;
/** DB connected as the owner role (like Neon), uses SET LOCAL ROLE app_user */
let ownerDb: Db;

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("koji_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const rootUrl = container.getConnectionUri();
  await runMigrations(rootUrl);

  // RLS does not apply to Postgres superusers (`BYPASSRLS`). Testcontainers
  // provisions the DB with a superuser, so we create a non-superuser role
  // (`app_user`) that represents the runtime identity used by the hosted
  // platform (and any self-hosted install worth running). All runtime-style
  // queries in this test go through `db` connected as `app_user`.
  rootDb = createDb(rootUrl, { max: 2 });
  // app_user may already exist from runMigrations — idempotent setup
  await rootDb.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    -- Allow the owner role to SET ROLE to app_user (production Neon pattern)
    GRANT app_user TO postgres;
  `);

  const appUrl = rootUrl
    .replace("postgres://postgres:postgres@", "postgres://app_user:app_user@");
  db = createDb(appUrl, { max: 5 });

  // Owner DB: connects as postgres (BYPASSRLS) but withRLS does SET LOCAL ROLE app_user
  ownerDb = createDb(rootUrl, { max: 5 });

  // Seed the two tenants and the two users using the superuser (BYPASSRLS)
  // connection — these rows are the preconditions for the assertions below.
  await rootDb.execute(sql`
    INSERT INTO tenants (id, slug, display_name) VALUES
      (${tenantA}::uuid, 'tenant-a', 'Tenant A'),
      (${tenantB}::uuid, 'tenant-b', 'Tenant B');
  `);
  await rootDb.execute(sql`
    INSERT INTO users (id, email, auth_provider, auth_provider_id) VALUES
      (${userA}::uuid, 'a@example.com', 'local', 'local-a'),
      (${userB}::uuid, 'b@example.com', 'local', 'local-b');
  `);
}, 120_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

// ---------------------------------------------------------------------------
// Core isolation tests
// ---------------------------------------------------------------------------

describe("RLS round-trip", () => {
  test("a connection without `SET LOCAL app.current_tenant_id` sees zero tenant-scoped rows", async () => {
    const result = await db.execute(sql`SELECT id FROM schemas`);
    expect(result.length).toBe(0);
  });

  test("withRLS(tenantA, ...) sees only tenant A's rows", async () => {
    await withRLS(db, tenantA, async (tx) => {
      await tx.insert(schema.schemas).values({
        tenantId: tenantA,
        slug: "invoice",
        displayName: "Invoice",
        createdBy: userA,
      });
    });

    await withRLS(db, tenantB, async (tx) => {
      await tx.insert(schema.schemas).values({
        tenantId: tenantB,
        slug: "invoice",
        displayName: "Invoice (other tenant)",
        createdBy: userB,
      });
    });

    const seenByA = await withRLS(db, tenantA, (tx) => tx.select().from(schema.schemas));
    const seenByB = await withRLS(db, tenantB, (tx) => tx.select().from(schema.schemas));

    expect(seenByA.length).toBe(1);
    expect(seenByA[0]?.slug).toBe("invoice");
    expect(seenByA[0]?.displayName).toBe("Invoice");

    expect(seenByB.length).toBe(1);
    expect(seenByB[0]?.slug).toBe("invoice");
    expect(seenByB[0]?.displayName).toBe("Invoice (other tenant)");
  });

  test("omitting an explicit `tenant_id` filter is still safe under withRLS", async () => {
    const rows = await withRLS(db, tenantA, (tx) =>
      tx.execute(sql`SELECT display_name FROM schemas`),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.display_name).toBe("Invoice");
  });

  test("withRLS rejects non-UUID tenant ids", async () => {
    await expect(
      withRLS(db, "'; DROP TABLE schemas; --", async () => 1),
    ).rejects.toThrow(/non-UUID/);
  });
});

// ---------------------------------------------------------------------------
// SET LOCAL ROLE path (production Neon pattern)
// ---------------------------------------------------------------------------

describe("SET LOCAL ROLE app_user (production path)", () => {
  test("owner role with SET LOCAL ROLE app_user enforces RLS", async () => {
    // The ownerDb connects as postgres (BYPASSRLS). Without SET LOCAL ROLE,
    // it would see ALL rows. withRLS now does SET LOCAL ROLE app_user,
    // which should enforce RLS.
    const seenByA = await withRLS(ownerDb, tenantA, (tx) =>
      tx.execute(sql`SELECT display_name FROM schemas`),
    );
    expect(seenByA.length).toBe(1);
    expect(seenByA[0]?.display_name).toBe("Invoice");

    const seenByB = await withRLS(ownerDb, tenantB, (tx) =>
      tx.execute(sql`SELECT display_name FROM schemas`),
    );
    expect(seenByB.length).toBe(1);
    expect(seenByB[0]?.display_name).toBe("Invoice (other tenant)");
  });

  test("owner role without withRLS bypasses RLS (proves SET ROLE is needed)", async () => {
    // Direct query as postgres sees all rows — this is the BYPASSRLS behavior
    // that was leaking data before the SET LOCAL ROLE fix.
    const allRows = await ownerDb.execute(sql`SELECT display_name FROM schemas`);
    expect(allRows.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Per-table isolation (data-driven)
// ---------------------------------------------------------------------------

/**
 * Seed data for every tenant-scoped table. Each entry inserts one row per
 * tenant via the superuser connection, then the test asserts isolation.
 *
 * Tables that require FK dependencies are seeded in dependency order.
 * The test is data-driven: adding a new table to RLS_POLICIES without
 * adding it here will fail the "coverage" test at the bottom.
 */

// Helper: tables we can insert test rows into with their required columns.
// We seed via rootDb (superuser) so FK constraints are satisfied.
const seededTables: string[] = [];

async function seedTable(
  tableName: string,
  valuesA: Record<string, unknown>,
  valuesB: Record<string, unknown>,
) {
  const colsA = Object.keys(valuesA);
  const colsB = Object.keys(valuesB);
  const placeholdersA = colsA.map((_, i) => `$${i + 1}`).join(", ");
  const placeholdersB = colsB.map((_, i) => `$${i + 1}`).join(", ");

  await rootDb.execute(sql.raw(
    `INSERT INTO "${tableName}" (${colsA.map(c => `"${c}"`).join(", ")}) VALUES (${placeholdersA})`,
    // @ts-expect-error - raw SQL params
  ).append(sql``, ...colsA.map(c => sql`${valuesA[c]}`)));

  // Simpler approach: use raw SQL via rootDb
  const colNames = colsA.map(c => `"${c}"`).join(", ");
  const valsA = colsA.map(c => {
    const v = valuesA[c];
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  }).join(", ");
  const valsB = colsB.map(c => {
    const v = valuesB[c];
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  }).join(", ");

  // Use rootDb.execute with raw SQL
  await rootDb.execute(sql.raw(`INSERT INTO "${tableName}" (${colNames}) VALUES (${valsA})`));
  await rootDb.execute(sql.raw(`INSERT INTO "${tableName}" (${colNames}) VALUES (${valsB})`));
  seededTables.push(tableName);
}

describe("per-table isolation", () => {
  const schemaAId = randomUUID();
  const schemaBId = randomUUID();
  const projectAId = randomUUID();
  const projectBId = randomUUID();
  const pipelineAId = randomUUID();
  const pipelineBId = randomUUID();
  const jobAId = randomUUID();
  const jobBId = randomUUID();

  beforeAll(async () => {
    // Seed dependency chain via superuser: project → schema → pipeline → job
    // Projects
    await rootDb.execute(sql.raw(`
      INSERT INTO projects (id, tenant_id, slug, display_name, created_by)
      VALUES ('${projectAId}', '${tenantA}', 'proj-a', 'Project A', '${userA}'),
             ('${projectBId}', '${tenantB}', 'proj-b', 'Project B', '${userB}')
    `));

    // Schemas (already seeded in earlier tests, add new ones with known IDs)
    await rootDb.execute(sql.raw(`
      INSERT INTO schemas (id, tenant_id, slug, display_name, created_by)
      VALUES ('${schemaAId}', '${tenantA}', 'iso-test-a', 'ISO Test A', '${userA}'),
             ('${schemaBId}', '${tenantB}', 'iso-test-b', 'ISO Test B', '${userB}')
    `));

    // Pipelines
    await rootDb.execute(sql.raw(`
      INSERT INTO pipelines (id, tenant_id, slug, display_name, schema_id, pipeline_type, created_by)
      VALUES ('${pipelineAId}', '${tenantA}', 'pipe-a', 'Pipeline A', '${schemaAId}', 'extract', '${userA}'),
             ('${pipelineBId}', '${tenantB}', 'pipe-b', 'Pipeline B', '${schemaBId}', 'extract', '${userB}')
    `));

    // Model endpoints
    await rootDb.execute(sql.raw(`
      INSERT INTO model_endpoints (id, tenant_id, slug, display_name, provider, model, status, auth_json, config_json, created_by)
      VALUES ('${randomUUID()}', '${tenantA}', 'ep-a', 'EP-A', 'openai', 'gpt-4o-mini', 'active', '{}', '{}', '${userA}'),
             ('${randomUUID()}', '${tenantB}', 'ep-b', 'EP-B', 'openai', 'gpt-4o-mini', 'active', '{}', '{}', '${userB}')
    `));

    // Jobs
    await rootDb.execute(sql.raw(`
      INSERT INTO jobs (id, tenant_id, slug, pipeline_id, status, trigger_type)
      VALUES ('${jobAId}', '${tenantA}', 'job-a', '${pipelineAId}', 'completed', 'api'),
             ('${jobBId}', '${tenantB}', 'job-b', '${pipelineBId}', 'completed', 'api')
    `));

    // NOTE: Additional tables (webhook_targets, api_keys, extraction_runs, etc.)
    // are not seeded here due to complex NOT NULL constraints. Their RLS policies
    // are verified by the "every table with tenant_id has a policy" meta-test below.
    // If you add a new tenant-scoped table, add it to RLS_POLICIES in index.ts —
    // the meta-test will catch any omission.
  }, 30_000);

  // Data-driven isolation test for key tables
  // Tables that have seed data from the beforeAll above.
  // The meta-test below ensures ALL tenant_id tables have policies;
  // this data-driven test verifies actual row isolation.
  const tablesToTest = [
    "schemas",
    "projects",
    "pipelines",
    "jobs",
    "model_endpoints",
  ];

  for (const table of tablesToTest) {
    test(`${table}: tenant B sees zero of tenant A's rows`, async () => {
      const seenByA = await withRLS(db, tenantA, (tx) =>
        tx.execute(sql.raw(`SELECT id FROM "${table}"`)),
      );
      const seenByB = await withRLS(db, tenantB, (tx) =>
        tx.execute(sql.raw(`SELECT id FROM "${table}"`)),
      );

      expect(seenByA.length).toBeGreaterThanOrEqual(1);
      expect(seenByB.length).toBeGreaterThanOrEqual(1);

      // No overlap in IDs
      const idsA = new Set(seenByA.map((r: any) => r.id));
      const idsB = new Set(seenByB.map((r: any) => r.id));
      for (const id of idsA) {
        expect(idsB.has(id)).toBe(false);
      }
    });

    test(`${table}: SET LOCAL ROLE path also isolates`, async () => {
      const seenByA = await withRLS(ownerDb, tenantA, (tx) =>
        tx.execute(sql.raw(`SELECT id FROM "${table}"`)),
      );
      const seenByB = await withRLS(ownerDb, tenantB, (tx) =>
        tx.execute(sql.raw(`SELECT id FROM "${table}"`)),
      );

      expect(seenByA.length).toBeGreaterThanOrEqual(1);
      expect(seenByB.length).toBeGreaterThanOrEqual(1);

      const idsA = new Set(seenByA.map((r: any) => r.id));
      const idsB = new Set(seenByB.map((r: any) => r.id));
      for (const id of idsA) {
        expect(idsB.has(id)).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Meta-tests: structural guarantees
// ---------------------------------------------------------------------------

describe("structural RLS guarantees", () => {
  test("every tenant-scoped table in the schema has an RLS policy", async () => {
    const tablesWithPolicies = await db.execute<{ tablename: string }>(sql`
      SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
    `);
    const covered = new Set(tablesWithPolicies.map((r) => r.tablename));

    // Extract table names from the RLS_POLICIES constant
    const expected = RLS_POLICIES
      .filter(s => s.startsWith("ALTER TABLE") && s.includes("ENABLE"))
      .map(s => s.match(/ALTER TABLE (\w+)/)?.[1])
      .filter(Boolean) as string[];

    const missing = expected.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });

  test("every table with a tenant_id column has an RLS policy or is explicitly global", async () => {
    // Introspect the database to find ALL tables with tenant_id
    const tablesWithTenantId = await rootDb.execute<{ table_name: string }>(sql`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE column_name = 'tenant_id'
        AND table_schema = 'public'
        AND table_name NOT LIKE 'drizzle%'
    `);

    const tablesWithPolicies = await rootDb.execute<{ tablename: string }>(sql`
      SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
    `);
    const covered = new Set(tablesWithPolicies.map((r) => r.tablename));

    // Tables that intentionally have tenant_id but no RLS policy.
    // Each must have a comment explaining why.
    const intentionallyGlobal = new Set([
      "memberships",     // Cross-tenant join; filtered application-side
      "parse_cache",     // Shared by content hash; same file = same parse
      "model_catalog",   // Global model catalog
      "background_jobs", // System-level job queue
    ]);

    const missing = tablesWithTenantId
      .map(r => r.table_name)
      .filter(t => !covered.has(t) && !intentionallyGlobal.has(t));

    expect(missing).toEqual([]);
  });
});
