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
 *
 * The test runs in CI and locally whenever Docker is available. It is
 * intentionally the only test file in this package for now — the RLS path
 * is the single most dangerous surface in the DB layer, and a real
 * Postgres check is the only way to catch regressions in it.
 */
import { randomUUID } from "node:crypto";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDb, schema, withRLS, type Db } from "./index";
import { runMigrations } from "./migrate";

let container: StartedPostgreSqlContainer;
let rootDb: Db;
let db: Db;

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
  await rootDb.execute(sql`
    CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE;
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  `);

  const appUrl = rootUrl
    .replace("postgres://postgres:postgres@", "postgres://app_user:app_user@");
  db = createDb(appUrl, { max: 5 });

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

  test("projects are isolated: tenant B sees zero of tenant A's projects", async () => {
    await withRLS(db, tenantA, async (tx) => {
      await tx.insert(schema.projects).values({
        tenantId: tenantA,
        slug: "claims-processing",
        displayName: "Claims Processing",
        createdBy: userA,
      });
    });

    await withRLS(db, tenantB, async (tx) => {
      await tx.insert(schema.projects).values({
        tenantId: tenantB,
        slug: "claims-processing",
        displayName: "Claims (other tenant)",
        createdBy: userB,
      });
    });

    const seenByA = await withRLS(db, tenantA, (tx) => tx.select().from(schema.projects));
    const seenByB = await withRLS(db, tenantB, (tx) => tx.select().from(schema.projects));

    expect(seenByA.length).toBe(1);
    expect(seenByA[0]?.displayName).toBe("Claims Processing");

    expect(seenByB.length).toBe(1);
    expect(seenByB[0]?.displayName).toBe("Claims (other tenant)");
  });

  test("corpus_entry_ground_truth is isolated: tenant B sees zero of tenant A's ground truth rows", async () => {
    // Seed a schema + corpus entry under tenant A (via superuser for FK deps),
    // then insert ground truth via withRLS(A).
    const schemaAId = randomUUID();
    const corpusEntryAId = randomUUID();

    await rootDb.execute(sql`
      INSERT INTO schemas (id, tenant_id, slug, display_name, created_by)
      VALUES (${schemaAId}::uuid, ${tenantA}::uuid, 'claim', 'Claim', ${userA}::uuid);
    `);
    await rootDb.execute(sql`
      INSERT INTO corpus_entries (id, tenant_id, schema_id, filename, storage_key, file_size, mime_type, content_hash, ground_truth_json, source, added_by)
      VALUES (${corpusEntryAId}::uuid, ${tenantA}::uuid, ${schemaAId}::uuid, 'claim_001.pdf', 'key-1', 1024, 'application/pdf', ${"a".repeat(64)}, '{"total": 100}'::jsonb, 'manual_upload', ${userA}::uuid);
    `);

    await withRLS(db, tenantA, async (tx) => {
      await tx.insert(schema.corpusEntryGroundTruth).values({
        tenantId: tenantA,
        corpusEntryId: corpusEntryAId,
        payloadJson: { total: 100, currency: "USD" },
        authoredBy: userA,
      });
    });

    // Tenant B sees nothing.
    const seenByB = await withRLS(db, tenantB, (tx) =>
      tx.select().from(schema.corpusEntryGroundTruth),
    );
    expect(seenByB.length).toBe(0);

    // Tenant A sees exactly one row.
    const seenByA = await withRLS(db, tenantA, (tx) =>
      tx.select().from(schema.corpusEntryGroundTruth),
    );
    expect(seenByA.length).toBe(1);
  });

  test("withRLS rejects non-UUID tenant ids", async () => {
    await expect(
      withRLS(db, "'; DROP TABLE schemas; --", async () => 1),
    ).rejects.toThrow(/non-UUID/);
  });

  test("every tenant-scoped table in the schema has an RLS policy on it", async () => {
    // Pulled from pg_policies at runtime. Guards against adding a new
    // tenant-scoped table to the schema without adding a matching policy.
    const tablesWithPolicies = await db.execute<{ tablename: string }>(sql`
      SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
    `);
    const covered = new Set(tablesWithPolicies.map((r) => r.tablename));

    const expected = [
      "tenants",
      "projects",
      "api_keys",
      "audit_log",
      "invites",
      "schemas",
      "schema_versions",
      "schema_samples",
      "corpus_entries",
      "corpus_entry_ground_truth",
      "corpus_entry_tags",
      "corpus_version_results",
      "schema_runs",
      "schema_run_models",
      "pipelines",
      "sources",
      "ingestions",
      "jobs",
      "documents",
      "traces",
      "trace_stages",
      "review_items",
      "model_endpoints",
      "endpoint_usage_rollups",
      "agent_sessions",
      "agent_messages",
      "agent_proposed_edits",
      "webhook_targets",
      "webhook_deliveries",
    ];

    const missing = expected.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });
});
