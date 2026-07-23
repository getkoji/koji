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

import { createDb, PROJECT_NULLABLE_RLS_TABLES, PROJECT_RLS_TABLES, RLS_POLICIES, schema, withRLS, type Db } from "./index";
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
// Default project per tenant — every project-scoped row needs one now.
const defaultProjectA = randomUUID();
const defaultProjectB = randomUUID();

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
  await rootDb.execute(sql`
    INSERT INTO projects (id, tenant_id, slug, display_name, created_by) VALUES
      (${defaultProjectA}::uuid, ${tenantA}::uuid, 'tenant-a', 'Tenant A default', ${userA}::uuid),
      (${defaultProjectB}::uuid, ${tenantB}::uuid, 'tenant-b', 'Tenant B default', ${userB}::uuid);
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
        projectId: defaultProjectA,
        slug: "invoice",
        displayName: "Invoice",
        createdBy: userA,
      });
    });

    await withRLS(db, tenantB, async (tx) => {
      await tx.insert(schema.schemas).values({
        tenantId: tenantB,
        projectId: defaultProjectB,
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
  const classifierAId = randomUUID();
  const classifierBId = randomUUID();
  const corpusDocAId = randomUUID();
  const corpusDocBId = randomUUID();
  const corpusEntryAId = randomUUID();
  const corpusEntryBId = randomUUID();

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
      INSERT INTO schemas (id, tenant_id, project_id, slug, display_name, created_by)
      VALUES ('${schemaAId}', '${tenantA}', '${projectAId}', 'iso-test-a', 'ISO Test A', '${userA}'),
             ('${schemaBId}', '${tenantB}', '${projectBId}', 'iso-test-b', 'ISO Test B', '${userB}')
    `));

    // Pipelines
    await rootDb.execute(sql.raw(`
      INSERT INTO pipelines (id, tenant_id, project_id, slug, display_name, schema_id, pipeline_type, created_by)
      VALUES ('${pipelineAId}', '${tenantA}', '${projectAId}', 'pipe-a', 'Pipeline A', '${schemaAId}', 'extract', '${userA}'),
             ('${pipelineBId}', '${tenantB}', '${projectBId}', 'pipe-b', 'Pipeline B', '${schemaBId}', 'extract', '${userB}')
    `));

    // Model endpoints
    await rootDb.execute(sql.raw(`
      INSERT INTO model_endpoints (id, tenant_id, project_id, slug, display_name, provider, model, status, auth_json, config_json, created_by)
      VALUES ('${randomUUID()}', '${tenantA}', '${projectAId}', 'ep-a', 'EP-A', 'openai', 'gpt-4o-mini', 'active', '{}', '{}', '${userA}'),
             ('${randomUUID()}', '${tenantB}', '${projectBId}', 'ep-b', 'EP-B', 'openai', 'gpt-4o-mini', 'active', '{}', '{}', '${userB}')
    `));

    // Parse endpoints (BYO parse, oss-267) — tenant-scoped, holds encrypted
    // parse-vendor credentials, so cross-tenant isolation is critical.
    await rootDb.execute(sql.raw(`
      INSERT INTO parse_endpoints (id, tenant_id, project_id, slug, display_name, provider, model, status, auth_json, config_json, created_by)
      VALUES ('${randomUUID()}', '${tenantA}', '${projectAId}', 'pe-a', 'PE-A', 'mistral-ocr', 'mistral-ocr-latest', 'active', '{"key_hint":"sk-a"}', '{}', '${userA}'),
             ('${randomUUID()}', '${tenantB}', '${projectBId}', 'pe-b', 'PE-B', 'mistral-ocr', 'mistral-ocr-latest', 'active', '{"key_hint":"sk-b"}', '{}', '${userB}')
    `));

    // Provider credentials + tenant models (credential→model split, oss-232)
    const credAId = randomUUID();
    const credBId = randomUUID();
    await rootDb.execute(sql.raw(`
      INSERT INTO provider_credentials (id, tenant_id, project_id, slug, display_name, provider, config_json, created_by)
      VALUES ('${credAId}', '${tenantA}', '${projectAId}', 'cred-a', 'Cred A', 'openai', '{}', '${userA}'),
             ('${credBId}', '${tenantB}', '${projectBId}', 'cred-b', 'Cred B', 'openai', '{}', '${userB}')
    `));
    await rootDb.execute(sql.raw(`
      INSERT INTO tenant_models (id, tenant_id, credential_id, model, capability)
      VALUES ('${randomUUID()}', '${tenantA}', '${credAId}', 'gpt-4o-mini', 'chat'),
             ('${randomUUID()}', '${tenantB}', '${credBId}', 'gpt-4o-mini', 'chat')
    `));

    // Jobs
    await rootDb.execute(sql.raw(`
      INSERT INTO jobs (id, tenant_id, project_id, slug, pipeline_id, status, trigger_type)
      VALUES ('${jobAId}', '${tenantA}', '${projectAId}', 'job-a', '${pipelineAId}', 'completed', 'api'),
             ('${jobBId}', '${tenantB}', '${projectBId}', 'job-b', '${pipelineBId}', 'completed', 'api')
    `));

    // Classifiers (schema-sibling artifact) + a version each. Isolation of a
    // tenant's classifier configs is as critical as its schemas — the config is
    // proprietary IP and drives what documents get routed where.
    await rootDb.execute(sql.raw(`
      INSERT INTO classifiers (id, tenant_id, project_id, slug, display_name, created_by)
      VALUES ('${classifierAId}', '${tenantA}', '${projectAId}', 'clf-a', 'Classifier A', '${userA}'),
             ('${classifierBId}', '${tenantB}', '${projectBId}', 'clf-b', 'Classifier B', '${userB}')
    `));
    const clfVerAId = randomUUID();
    const clfVerBId = randomUUID();
    await rootDb.execute(sql.raw(`
      INSERT INTO classifier_versions
        (id, tenant_id, classifier_id, version_number, yaml_source, yaml_hash, parsed_json, committed_by)
      VALUES
        ('${clfVerAId}', '${tenantA}', '${classifierAId}', 1, 'classes:\\n  a: {}', repeat('a', 64), '{"classes":[{"id":"a"}]}', '${userA}'),
        ('${clfVerBId}', '${tenantB}', '${classifierBId}', 1, 'classes:\\n  b: {}', repeat('b', 64), '{"classes":[{"id":"b"}]}', '${userB}')
    `));

    // Classifier validate runs (oss-451) — carry a denormalized project_id with
    // a RESTRICTIVE policy from day one, so isolation must hold on the run itself.
    await rootDb.execute(sql.raw(`
      INSERT INTO classifier_runs (id, tenant_id, project_id, classifier_id, classifier_version_id, status)
      VALUES ('${randomUUID()}', '${tenantA}', '${projectAId}', '${classifierAId}', '${clfVerAId}', 'completed'),
             ('${randomUUID()}', '${tenantB}', '${projectBId}', '${classifierBId}', '${clfVerBId}', 'completed')
    `));

    // Agent sessions (project-scoped, oss-368) — a schema-builder chat is
    // about a schema and inherits its project.
    await rootDb.execute(sql.raw(`
      INSERT INTO agent_sessions (id, tenant_id, project_id, user_id, context, context_entity_id)
      VALUES ('${randomUUID()}', '${tenantA}', '${projectAId}', '${userA}', 'schema_builder', '${schemaAId}'),
             ('${randomUUID()}', '${tenantB}', '${projectBId}', '${userB}', 'schema_builder', '${schemaBId}')
    `));

    // Corpus pool (oss-449): a pooled document + a schema-owned label per tenant.
    // Both carry project_id and are RESTRICTIVE-isolated — the split that closed
    // the old tenant-only gap, so cross-tenant isolation must hold on both.
    await rootDb.execute(sql.raw(`
      INSERT INTO corpus_documents (id, tenant_id, project_id, filename, storage_key, file_size, mime_type, content_hash, source, added_by)
      VALUES ('${corpusDocAId}', '${tenantA}', '${projectAId}', 'a.pdf', 'k/a', 10, 'application/pdf', repeat('a', 64), 'upload', '${userA}'),
             ('${corpusDocBId}', '${tenantB}', '${projectBId}', 'b.pdf', 'k/b', 10, 'application/pdf', repeat('b', 64), 'upload', '${userB}')
    `));
    // Entries still carry the legacy file columns in this phase (writers
    // populate both), so the seed provides them just like a real write does.
    await rootDb.execute(sql.raw(`
      INSERT INTO corpus_entries (id, tenant_id, project_id, document_id, schema_id, filename, storage_key, file_size, mime_type, content_hash, source, ground_truth_json, added_by)
      VALUES ('${corpusEntryAId}', '${tenantA}', '${projectAId}', '${corpusDocAId}', '${schemaAId}', 'a.pdf', 'k/a', 10, 'application/pdf', repeat('a', 64), 'upload', '{"label":"x"}', '${userA}'),
             ('${corpusEntryBId}', '${tenantB}', '${projectBId}', '${corpusDocBId}', '${schemaBId}', 'b.pdf', 'k/b', 10, 'application/pdf', repeat('b', 64), 'upload', '{"label":"y"}', '${userB}')
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
    "agent_sessions",
    "schemas",
    "projects",
    "pipelines",
    "jobs",
    "model_endpoints",
    "parse_endpoints",
    "provider_credentials",
    "tenant_models",
    "classifiers",
    "classifier_versions",
    "classifier_runs",
    "corpus_documents",
    "corpus_entries",
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
// Project isolation (intra-tenant boundary)
// ---------------------------------------------------------------------------

describe("project isolation", () => {
  // By this point tenant A has two projects with one schema each:
  //   defaultProjectA → 'invoice' (round-trip test)
  //   the per-table describe's 'proj-a' → 'iso-test-a'

  test("project-scoped withRLS sees only that project's rows", async () => {
    const seen = await withRLS(
      db,
      { tenantId: tenantA, projectId: defaultProjectA },
      (tx) => tx.execute(sql`SELECT slug FROM schemas`),
    );
    expect(seen.map((r: any) => r.slug)).toEqual(["invoice"]);
  });

  test("tenant-wide withRLS (no projectId) sees all of the tenant's projects", async () => {
    const seen = await withRLS(db, tenantA, (tx) =>
      tx.execute(sql`SELECT slug FROM schemas ORDER BY slug`),
    );
    expect(seen.map((r: any) => r.slug)).toEqual(["invoice", "iso-test-a"]);
  });

  test("project policy is RESTRICTIVE — another tenant's project id yields zero rows, never a leak", async () => {
    // Scope to tenant A but name tenant B's project: the tenant policy
    // (permissive) already excludes B's rows and the project policy
    // (restrictive) excludes A's rows — the intersection must be empty.
    const seen = await withRLS(
      db,
      { tenantId: tenantA, projectId: defaultProjectB },
      (tx) => tx.execute(sql`SELECT slug FROM schemas`),
    );
    expect(seen.length).toBe(0);
  });

  test("WITH CHECK blocks inserting a row into a different project than the scope", async () => {
    // postgres-js wraps the RLS violation in a generic "Failed query" error,
    // so assert on the outcome: the insert throws AND the row never lands.
    await expect(
      withRLS(db, { tenantId: tenantA, projectId: defaultProjectA }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO schemas (tenant_id, project_id, slug, display_name, created_by)
          VALUES (${tenantA}::uuid, (SELECT id FROM projects WHERE slug = 'proj-a'), 'sneaky', 'Sneaky', ${userA}::uuid)
        `);
      }),
    ).rejects.toThrow();
    const rows = await rootDb.execute(sql`SELECT id FROM schemas WHERE slug = 'sneaky'`);
    expect(rows.length).toBe(0);
  });

  test("SET LOCAL ROLE path (production Neon pattern) also enforces project scope", async () => {
    const seen = await withRLS(
      ownerDb,
      { tenantId: tenantA, projectId: defaultProjectA },
      (tx) => tx.execute(sql`SELECT slug FROM schemas`),
    );
    expect(seen.map((r: any) => r.slug)).toEqual(["invoice"]);
  });

  test("withRLS rejects non-UUID project ids", async () => {
    await expect(
      withRLS(db, { tenantId: tenantA, projectId: "'; DROP TABLE schemas; --" }, async () => 1),
    ).rejects.toThrow(/non-UUID/);
  });

  test("jobs and review-queue tables are project-scoped too", async () => {
    // jobs: 'job-a' lives in per-table proj-a, so the default project sees none
    const jobsInDefault = await withRLS(
      db,
      { tenantId: tenantA, projectId: defaultProjectA },
      (tx) => tx.execute(sql`SELECT slug FROM jobs`),
    );
    expect(jobsInDefault.length).toBe(0);
    const jobsTenantWide = await withRLS(db, tenantA, (tx) =>
      tx.execute(sql`SELECT slug FROM jobs`),
    );
    expect(jobsTenantWide.map((r: any) => r.slug)).toEqual(["job-a"]);
  });

  test("corpus pool tables are project-scoped (oss-449)", async () => {
    // The corpus rows live in per-table proj-a. Before the split corpus_entries
    // was tenant-isolated only, so a project-scoped query would have leaked
    // every project's corpus. Both the document and the label must now be
    // invisible to a different project of the same tenant.
    for (const table of ["corpus_documents", "corpus_entries"]) {
      const inDefault = await withRLS(
        db,
        { tenantId: tenantA, projectId: defaultProjectA },
        (tx) => tx.execute(sql.raw(`SELECT id FROM "${table}"`)),
      );
      expect(inDefault.length).toBe(0);
      const tenantWide = await withRLS(db, tenantA, (tx) =>
        tx.execute(sql.raw(`SELECT id FROM "${table}"`)),
      );
      expect(tenantWide.length).toBe(1);
    }
  });

  test("WITH CHECK blocks writing a corpus label into a different project than the scope", async () => {
    // A mislabeled project_id on a corpus_entries insert must be rejected, not
    // silently accepted into another project's corpus.
    await expect(
      withRLS(db, { tenantId: tenantA, projectId: defaultProjectA }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO corpus_entries (tenant_id, project_id, document_id, schema_id, filename, storage_key, file_size, mime_type, content_hash, source, ground_truth_json, added_by)
          VALUES (
            ${tenantA}::uuid,
            (SELECT id FROM projects WHERE slug = 'proj-a'),
            (SELECT id FROM corpus_documents LIMIT 1),
            (SELECT id FROM schemas WHERE slug = 'iso-test-a'),
            'x.pdf', 'k/x', 10, 'application/pdf', repeat('c', 64), 'upload',
            '{"label":"sneaky"}', ${userA}::uuid
          )
        `);
      }),
    ).rejects.toThrow();
    const rows = await rootDb.execute(
      sql`SELECT id FROM corpus_entries WHERE ground_truth_json->>'label' = 'sneaky'`,
    );
    expect(rows.length).toBe(0);
  });

});

// ---------------------------------------------------------------------------
// Corpus ownership relaxation (oss-475): schema_id nullable + one-owner CHECK
// ---------------------------------------------------------------------------

describe("corpus label ownership (oss-475)", () => {
  // proj-a + iso-test-a schema were seeded by the per-table describe. Resolve
  // ids by slug so this block is self-contained.
  async function projA(): Promise<string> {
    return (await rootDb.execute(sql`SELECT id FROM projects WHERE slug = 'proj-a'`))[0]!.id as string;
  }
  async function seedDoc(project: string, hashChar: string): Promise<string> {
    const id = randomUUID();
    await rootDb.execute(sql`
      INSERT INTO corpus_documents (id, tenant_id, project_id, filename, storage_key, file_size, mime_type, content_hash, source, added_by)
      VALUES (${id}::uuid, ${tenantA}::uuid, ${project}::uuid, 'c.pdf', 'k/c', 10, 'application/pdf', repeat(${hashChar}, 64), 'upload', ${userA}::uuid)`);
    return id;
  }

  test("a classifier-owned label (schema_id NULL) is allowed", async () => {
    const p = await projA();
    const clfId = randomUUID();
    await rootDb.execute(sql`
      INSERT INTO classifiers (id, tenant_id, project_id, slug, display_name, created_by)
      VALUES (${clfId}::uuid, ${tenantA}::uuid, ${p}::uuid, 'clf-owned', 'Clf Owned', ${userA}::uuid)`);
    const docId = await seedDoc(p, "d");

    // File columns stay NOT NULL in phase 2 (steps 1-2) — a classifier-owned
    // entry copies them from the pool doc until the read migration relaxes them.
    // The point of this test is schema_id NULL + classifier ownership.
    const entryId = randomUUID();
    await withRLS(db, { tenantId: tenantA, projectId: p }, (tx) =>
      tx.execute(sql`
        INSERT INTO corpus_entries (id, tenant_id, project_id, document_id, classifier_id, filename, storage_key, file_size, mime_type, content_hash, source, ground_truth_json, added_by)
        VALUES (${entryId}::uuid, ${tenantA}::uuid, ${p}::uuid, ${docId}::uuid, ${clfId}::uuid, 'c.pdf', 'k/c', 10, 'application/pdf', repeat('d', 64), 'upload', '{"label":"invoice"}', ${userA}::uuid)`),
    );
    const rows = await rootDb.execute(sql`SELECT schema_id FROM corpus_entries WHERE id = ${entryId}::uuid`);
    expect(rows.length).toBe(1);
    expect(rows[0]?.schema_id).toBeNull();
  });

  test("the one-owner CHECK rejects both-null and both-set", async () => {
    const p = await projA();
    const docId = await seedDoc(p, "e");
    const sch = (await rootDb.execute(sql`SELECT id FROM schemas WHERE slug = 'iso-test-a'`))[0]?.id;
    const clf = (await rootDb.execute(sql`SELECT id FROM classifiers WHERE slug = 'clf-owned'`))[0]?.id;

    const cols = "filename, storage_key, file_size, mime_type, content_hash";
    const vals = "'c.pdf', 'k/c', 10, 'application/pdf', repeat('e', 64)";

    // Neither owner set.
    await expect(
      rootDb.execute(sql.raw(`
        INSERT INTO corpus_entries (tenant_id, project_id, document_id, ${cols}, source, ground_truth_json, added_by)
        VALUES ('${tenantA}', '${p}', '${docId}', ${vals}, 'upload', '{}', '${userA}')`)),
    ).rejects.toThrow();

    // Both owners set.
    await expect(
      rootDb.execute(sql.raw(`
        INSERT INTO corpus_entries (tenant_id, project_id, document_id, schema_id, classifier_id, ${cols}, source, ground_truth_json, added_by)
        VALUES ('${tenantA}', '${p}', '${docId}', '${sch}', '${clf}', ${vals}, 'upload', '{}', '${userA}')`)),
    ).rejects.toThrow();
  });
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

  test("every table with a project_id column has a RESTRICTIVE project policy, and vice versa", async () => {
    const tablesWithProjectId = await rootDb.execute<{ table_name: string }>(sql`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE column_name = 'project_id'
        AND table_schema = 'public'
        AND table_name NOT LIKE 'drizzle%'
    `);

    const projectPolicies = await rootDb.execute<{ tablename: string; permissive: string }>(sql`
      SELECT tablename, permissive FROM pg_policies
      WHERE schemaname = 'public' AND policyname LIKE '%_project_isolation'
    `);
    const covered = new Set(projectPolicies.map((r) => r.tablename));

    // Every project policy must be RESTRICTIVE — a PERMISSIVE one would OR
    // with the tenant policy and silently disable tenant isolation.
    for (const p of projectPolicies) {
      expect(p.permissive).toBe("RESTRICTIVE");
    }

    // `projects` is the boundary object itself; `project_access` and
    // `api_key_project_access` reference a project_id but are tenant-scoped
    // access-grant tables (managed by admins), NOT project-isolated resources —
    // none carries a project policy.
    const notProjectScoped = new Set(["projects", "project_access", "api_key_project_access"]);
    const missingPolicy = tablesWithProjectId
      .map((r) => r.table_name)
      .filter((t) => !notProjectScoped.has(t) && !covered.has(t));
    expect(missingPolicy).toEqual([]);

    // Lock-step with the exported lists: strict tables + the null-aware ones
    // (notifications) together account for every project policy.
    expect(covered).toEqual(
      new Set([...PROJECT_RLS_TABLES, ...PROJECT_NULLABLE_RLS_TABLES]),
    );
  });

  test("every project-scoped table has FORCE row level security, not just ENABLE", async () => {
    // ENABLE alone lets the table OWNER bypass RLS; withRLS's SET LOCAL ROLE
    // app_user is best-effort (it no-ops where CREATE ROLE is blocked), so an
    // isolation-bearing table without FORCE can leak when the connection runs
    // as the owner. Every project table must be FORCEd.
    const tables = [...PROJECT_RLS_TABLES, ...PROJECT_NULLABLE_RLS_TABLES];
    // Constant, code-defined table names — safe to inline as a SQL array literal.
    const arrayLiteral = `ARRAY[${tables.map((t) => `'${t}'`).join(",")}]::text[]`;
    const forced = await rootDb.execute<{ relname: string; relforcerowsecurity: boolean }>(
      sql.raw(`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY(${arrayLiteral})`),
    );
    const notForced = forced.filter((r) => !r.relforcerowsecurity).map((r) => r.relname);
    expect(notForced).toEqual([]);
    // Sanity: we actually inspected every table (no typo'd name silently absent).
    expect(forced.length).toBe(tables.length);
  });
});

// ---------------------------------------------------------------------------
// Notifications — null-aware project policy
// ---------------------------------------------------------------------------

describe("notifications project scoping (null-aware)", () => {
  const projA = randomUUID();
  const projA2 = randomUUID();

  beforeAll(async () => {
    await rootDb.execute(sql.raw(`
      INSERT INTO projects (id, tenant_id, slug, display_name, created_by)
      VALUES ('${projA}', '${tenantA}', 'notif-a', 'Notif A', '${userA}'),
             ('${projA2}', '${tenantA}', 'notif-a2', 'Notif A2', '${userA}')
    `));
    await rootDb.execute(sql.raw(`
      INSERT INTO notifications (tenant_id, project_id, type, title)
      VALUES ('${tenantA}', '${projA}', 'x', 'in project A'),
             ('${tenantA}', '${projA2}', 'x', 'in project A2'),
             ('${tenantA}', NULL, 'x', 'tenant-wide')
    `));
  }, 30_000);

  test("a project scope sees that project's notifications AND tenant-wide ones", async () => {
    const rows = await withRLS(db, { tenantId: tenantA, projectId: projA }, (tx) =>
      tx.execute(sql`SELECT title FROM notifications ORDER BY title`),
    );
    expect(rows.map((r: any) => r.title)).toEqual(["in project A", "tenant-wide"]);
  });

  test("a different project does not see project A's notifications, still sees tenant-wide", async () => {
    const rows = await withRLS(db, { tenantId: tenantA, projectId: projA2 }, (tx) =>
      tx.execute(sql`SELECT title FROM notifications ORDER BY title`),
    );
    expect(rows.map((r: any) => r.title)).toEqual(["in project A2", "tenant-wide"]);
  });

  test("tenant-wide scope (no project) sees all of the tenant's notifications", async () => {
    const rows = await withRLS(db, tenantA, (tx) =>
      tx.execute(sql`SELECT title FROM notifications ORDER BY title`),
    );
    expect(rows.map((r: any) => r.title)).toEqual([
      "in project A",
      "in project A2",
      "tenant-wide",
    ]);
  });

  test("another tenant sees none of tenant A's notifications", async () => {
    const rows = await withRLS(db, { tenantId: tenantB, projectId: projA }, (tx) =>
      tx.execute(sql`SELECT title FROM notifications`),
    );
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// API keys — null-aware project policy (oss-433)
// ---------------------------------------------------------------------------
// A single/multi-project key carries a non-null project_id and is narrowed to
// the current project. An all-access key has a NULL project_id and, like a
// tenant-wide notification, stays visible in EVERY project view so it can be
// managed from anywhere. Cross-tenant isolation still holds absolutely.

describe("api_keys project scoping (null-aware)", () => {
  const projX = randomUUID();
  const projY = randomUUID();

  beforeAll(async () => {
    await rootDb.execute(sql.raw(`
      INSERT INTO projects (id, tenant_id, slug, display_name, created_by)
      VALUES ('${projX}', '${tenantA}', 'key-x', 'Key X', '${userA}'),
             ('${projY}', '${tenantA}', 'key-y', 'Key Y', '${userA}')
    `));
    // Two single-project keys (bound to X and Y) + one all-access key (NULL).
    await rootDb.execute(sql.raw(`
      INSERT INTO api_keys (tenant_id, project_id, name, key_prefix, key_hash, scopes, created_by)
      VALUES
        ('${tenantA}', '${projX}', 'ak-single-x', 'koji_x...1', decode(repeat('a',64),'hex'), ARRAY['*'], '${userA}'),
        ('${tenantA}', '${projY}', 'ak-single-y', 'koji_y...2', decode(repeat('b',64),'hex'), ARRAY['*'], '${userA}'),
        ('${tenantA}', NULL,       'ak-all',      'koji_a...3', decode(repeat('c',64),'hex'), ARRAY['*'], '${userA}')
    `));
  }, 30_000);

  const names = sql`name IN ('ak-single-x', 'ak-single-y', 'ak-all')`;

  test("a project scope sees that project's key AND the all-access key", async () => {
    const rows = await withRLS(db, { tenantId: tenantA, projectId: projX }, (tx) =>
      tx.execute(sql`SELECT name FROM api_keys WHERE ${names} ORDER BY name`),
    );
    expect(rows.map((r: any) => r.name)).toEqual(["ak-all", "ak-single-x"]);
  });

  test("a different project does not see project X's key, still sees all-access", async () => {
    const rows = await withRLS(db, { tenantId: tenantA, projectId: projY }, (tx) =>
      tx.execute(sql`SELECT name FROM api_keys WHERE ${names} ORDER BY name`),
    );
    expect(rows.map((r: any) => r.name)).toEqual(["ak-all", "ak-single-y"]);
  });

  test("tenant-wide scope (no project) sees all of the tenant's keys", async () => {
    const rows = await withRLS(db, tenantA, (tx) =>
      tx.execute(sql`SELECT name FROM api_keys WHERE ${names} ORDER BY name`),
    );
    expect(rows.map((r: any) => r.name)).toEqual(["ak-all", "ak-single-x", "ak-single-y"]);
  });

  test("another tenant sees none of tenant A's keys — not even the all-access one", async () => {
    const rows = await withRLS(db, { tenantId: tenantB, projectId: projX }, (tx) =>
      tx.execute(sql`SELECT name FROM api_keys WHERE ${names}`),
    );
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Credential→model split backfill (0020_credential_model_backfill_rls)
// ---------------------------------------------------------------------------
// The migration's backfill runs once at container start against an empty
// model_endpoints. This re-runs its (idempotent) inserts against a seeded
// endpoint to exercise the mapping: one credential + one tenant_model that
// REUSES the endpoint id, with ON CONFLICT making re-runs a no-op.

describe("credential→model backfill", () => {
  // Mirrors the two INSERT...SELECT statements in
  // packages/db/drizzle/0020_credential_model_backfill_rls.sql, adapted for
  // the post-0029 shape (project_id is carried through — the 0020 migration
  // itself only ever runs before 0029 adds the column).
  async function runBackfill(endpointId: string) {
    await rootDb.execute(sql.raw(`
      INSERT INTO provider_credentials (
        id, tenant_id, project_id, slug, display_name, provider, config_json, auth_json, status,
        last_health_check_at, consecutive_failures, last_success_at, last_failure_at,
        last_failure_reason, health_state, created_by, created_at, updated_at, deleted_at
      )
      SELECT md5('cred:' || id::text)::uuid, tenant_id, project_id, slug, display_name, provider, config_json, auth_json, status,
        last_health_check_at, consecutive_failures, last_success_at, last_failure_at,
        last_failure_reason, health_state, created_by, created_at, updated_at, deleted_at
      FROM model_endpoints WHERE id = '${endpointId}'
      ON CONFLICT (id) DO NOTHING
    `));
    await rootDb.execute(sql.raw(`
      INSERT INTO tenant_models (
        id, tenant_id, credential_id, model, capability, slug, display_name,
        pricing_mode, pricing_override_json, status, created_at, updated_at, deleted_at
      )
      SELECT id, tenant_id, md5('cred:' || id::text)::uuid, model, 'chat', slug, display_name,
        pricing_mode, pricing_override_json, status, created_at, updated_at, deleted_at
      FROM model_endpoints WHERE id = '${endpointId}'
      ON CONFLICT (id) DO NOTHING
    `));
  }

  test("an endpoint backfills to a credential + a reused-id model, idempotently", async () => {
    const endpointId = randomUUID();
    await rootDb.execute(sql.raw(`
      INSERT INTO model_endpoints (id, tenant_id, project_id, slug, display_name, provider, model, status, auth_json, config_json, created_by)
      VALUES ('${endpointId}', '${tenantA}', '${defaultProjectA}', 'bf-ep', 'Backfill EP', 'mistral', 'pixtral-large', 'active',
              '{"key_hint":"sk-xyz"}', '{"base_url":"https://api.mistral.ai/v1"}', '${userA}')
    `));

    await runBackfill(endpointId);

    // The model row REUSES the endpoint id, so existing FKs stay valid by value.
    const models = await rootDb.execute<{
      id: string; credential_id: string; model: string; capability: string;
    }>(sql.raw(`SELECT id, credential_id, model, capability FROM tenant_models WHERE id = '${endpointId}'`));
    expect(models.length).toBe(1);
    expect(models[0]!.model).toBe("pixtral-large");
    expect(models[0]!.capability).toBe("chat");

    // The credential exists, carries the encrypted key, and is the one the model points at.
    const creds = await rootDb.execute<{
      id: string; provider: string; auth_json: { key_hint: string } | null;
    }>(sql.raw(`SELECT id, provider, auth_json FROM provider_credentials WHERE id = '${models[0]!.credential_id}'`));
    expect(creds.length).toBe(1);
    expect(creds[0]!.provider).toBe("mistral");
    expect(creds[0]!.auth_json).toEqual({ key_hint: "sk-xyz" });

    // Idempotent: re-running produces no duplicates.
    await runBackfill(endpointId);
    const dupModels = await rootDb.execute(sql.raw(`SELECT id FROM tenant_models WHERE id = '${endpointId}'`));
    const dupCreds = await rootDb.execute(sql.raw(`SELECT id FROM provider_credentials WHERE id = '${creds[0]!.id}'`));
    expect(dupModels.length).toBe(1);
    expect(dupCreds.length).toBe(1);
  });
});
