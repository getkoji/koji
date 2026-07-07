/**
 * Integration test for the /api/overview query (fetchOverviewData) against a
 * real Postgres (Testcontainers), run under the app_user role so the RLS
 * policies production hits are actually exercised.
 *
 * The point of these tests is project scoping: schema_runs, corpus_entries, and
 * extraction_runs carry no project_id, so RLS does not narrow them on their own.
 * The query keeps them project-scoped by JOINing the project-scoped `schemas`
 * table on schema_id. Without that join, a project's overview leaks tenant-wide
 * numbers (another project's latest accuracy, validate regressions, onboarding
 * state). A mocked DB would prove none of this — it has to be real Postgres RLS.
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import { fetchOverviewData } from "./overview";

let container: StartedPostgreSqlContainer;
let rootDb: Db; // superuser — bypasses RLS for seeding
let db: Db; // app_user — RLS enforced, what the route uses

const tenant = randomUUID();
const user = randomUUID();
const projA = randomUUID();
const projB = randomUUID();

const HASH = "a".repeat(64);

async function reseed() {
  await rootDb.execute(sql`SET client_min_messages = warning`);
  // schemas CASCADEs to schema_versions, schema_runs, corpus_entries,
  // extraction_runs (all reference it ON DELETE CASCADE).
  await rootDb.execute(sql`TRUNCATE schemas RESTART IDENTITY CASCADE`);
}

/** Seed a schema + one released version in a project. Returns their ids. */
async function seedSchema(project: string, slug: string) {
  const schemaId = randomUUID();
  const versionId = randomUUID();
  await rootDb.execute(sql`
    INSERT INTO schemas (id, tenant_id, project_id, slug, display_name, created_by)
    VALUES (${schemaId}::uuid, ${tenant}::uuid, ${project}::uuid, ${slug}, ${slug}, ${user}::uuid)`);
  await rootDb.execute(sql`
    INSERT INTO schema_versions
      (id, tenant_id, schema_id, version_number, yaml_source, yaml_hash, parsed_json, committed_by)
    VALUES
      (${versionId}::uuid, ${tenant}::uuid, ${schemaId}::uuid, 1, 'x: 1', ${HASH}, '{}'::jsonb, ${user}::uuid)`);
  return { schemaId, versionId };
}

/** Seed a completed validate run with a given accuracy + regression count. */
async function seedValidateRun(
  schemaId: string,
  versionId: string,
  accuracy: string, // numeric(6,4) — passed as a string literal
  regressions: number,
  createdAt: string,
) {
  await rootDb.execute(sql`
    INSERT INTO schema_runs
      (id, tenant_id, schema_id, schema_version_id, run_type, status, accuracy, regressions_count, created_at)
    VALUES
      (${randomUUID()}::uuid, ${tenant}::uuid, ${schemaId}::uuid, ${versionId}::uuid,
       'validate', 'completed', ${accuracy}, ${regressions}, ${createdAt}::timestamptz)`);
}

/** Seed a corpus entry (with non-empty ground truth) + an extraction run. */
async function seedCorpusAndExtraction(schemaId: string) {
  const corpusId = randomUUID();
  await rootDb.execute(sql`
    INSERT INTO corpus_entries
      (id, tenant_id, schema_id, filename, storage_key, file_size, mime_type,
       content_hash, ground_truth_json, source, added_by)
    VALUES
      (${corpusId}::uuid, ${tenant}::uuid, ${schemaId}::uuid, 'doc.pdf', 'k/doc.pdf', 100,
       'application/pdf', ${HASH}, '{"field":"x"}'::jsonb, 'upload', ${user}::uuid)`);
  await rootDb.execute(sql`
    INSERT INTO extraction_runs
      (id, tenant_id, schema_id, corpus_entry_id, model, extracted_json)
    VALUES
      (${randomUUID()}::uuid, ${tenant}::uuid, ${schemaId}::uuid, ${corpusId}::uuid,
       'gpt-4o-mini', '{"field":"x"}'::jsonb)`);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("koji_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();
  const rootUrl = container.getConnectionUri();
  await runMigrations(rootUrl);
  rootDb = createDb(rootUrl, { max: 2 });
  await rootDb.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
    GRANT app_user TO postgres;
  `);
  db = createDb(rootUrl.replace("postgres://postgres:postgres@", "postgres://app_user:app_user@"), { max: 5 });

  await rootDb.execute(sql`INSERT INTO tenants (id, slug, display_name) VALUES (${tenant}::uuid, 't', 'T')`);
  await rootDb.execute(
    sql`INSERT INTO users (id, email, auth_provider, auth_provider_id) VALUES (${user}::uuid, 'u@x.com', 'local', 'u')`,
  );
  await rootDb.execute(sql`INSERT INTO projects (id, tenant_id, slug, display_name, created_by) VALUES
    (${projA}::uuid, ${tenant}::uuid, 'proj-a', 'A', ${user}::uuid),
    (${projB}::uuid, ${tenant}::uuid, 'proj-b', 'B', ${user}::uuid)`);
}, 120_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

beforeEach(reseed);

describe("overview project scoping", () => {
  test("does not leak another project's runs, corpus, or extraction", async () => {
    // Project A is an otherwise-normal project with a schema but no activity.
    await seedSchema(projA, "a-schema");
    // Project B is full of runs/corpus/extraction. None of it belongs to A.
    const b = await seedSchema(projB, "b-schema");
    await seedValidateRun(b.schemaId, b.versionId, "0.9000", 3, "2026-01-01T00:00:00Z");
    await seedCorpusAndExtraction(b.schemaId);

    const d = await fetchOverviewData(db, tenant, projA);

    expect(d.metrics.accuracy).toBeNull();
    expect(d.latestValidate).toBeNull();
    expect(d.onboarding.has_validate).toBe(false);
    expect(d.onboarding.has_corpus).toBe(false);
    expect(d.onboarding.has_ground_truth).toBe(false);
    expect(d.onboarding.has_extraction).toBe(false);
  });

  test("reports the selected project's own activity", async () => {
    const b = await seedSchema(projB, "b-schema");
    await seedValidateRun(b.schemaId, b.versionId, "0.9000", 3, "2026-01-01T00:00:00Z");
    await seedCorpusAndExtraction(b.schemaId);

    const d = await fetchOverviewData(db, tenant, projB);

    expect(d.metrics.accuracy).toBeCloseTo(90);
    expect(d.latestValidate.regressions_count).toBe(3);
    expect(d.onboarding.has_validate).toBe(true);
    expect(d.onboarding.has_corpus).toBe(true);
    expect(d.onboarding.has_ground_truth).toBe(true);
    expect(d.onboarding.has_extraction).toBe(true);
  });

  test("accuracy tile reflects the project's own latest run, not the tenant's", async () => {
    // Both projects have a completed run. B's is newer, so a tenant-wide
    // "latest completed run" query would return B's accuracy for everyone.
    const a = await seedSchema(projA, "a-schema");
    const b = await seedSchema(projB, "b-schema");
    await seedValidateRun(a.schemaId, a.versionId, "0.7000", 0, "2026-01-01T00:00:00Z");
    await seedValidateRun(b.schemaId, b.versionId, "0.9000", 5, "2026-06-01T00:00:00Z");

    const dA = await fetchOverviewData(db, tenant, projA);
    const dB = await fetchOverviewData(db, tenant, projB);

    expect(dA.metrics.accuracy).toBeCloseTo(70);
    expect(dB.metrics.accuracy).toBeCloseTo(90);
  });
});
