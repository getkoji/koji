/**
 * Integration test for moveResource against a real Postgres (Testcontainers),
 * because the whole point of the module is cross-project RLS behaviour and
 * reference integrity — a mocked DB proves nothing here.
 *
 * Runs under the app_user role (the production RLS identity), so the moves are
 * exercised through the same policies production hits.
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, schema, withRLS, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import { deriveCredentialId } from "../routes/model-providers";
import { moveResource } from "./move";

let container: StartedPostgreSqlContainer;
let rootDb: Db;
let db: Db; // app_user connection — RLS enforced

const tenant = randomUUID();
const user = randomUUID();
const projA = randomUUID();
const projB = randomUUID();

async function reseed() {
  // Wipe the project-scoped tables between tests (children first). SET
  // client_min_messages hushes the TRUNCATE ... CASCADE NOTICE spam.
  await rootDb.execute(sql`SET client_min_messages = warning`);
  await rootDb.execute(sql`
    TRUNCATE review_items, documents, jobs, sources, pipelines, parse_endpoints,
      tenant_models, provider_credentials, model_endpoints, classifiers, schemas
    RESTART IDENTITY CASCADE
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("koji_test").withUsername("postgres").withPassword("postgres").start();
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
  await rootDb.execute(sql`INSERT INTO users (id, email, auth_provider, auth_provider_id) VALUES (${user}::uuid, 'u@x.com', 'local', 'u')`);
  await rootDb.execute(sql`INSERT INTO projects (id, tenant_id, slug, display_name, created_by) VALUES
    (${projA}::uuid, ${tenant}::uuid, 'proj-a', 'A', ${user}::uuid),
    (${projB}::uuid, ${tenant}::uuid, 'proj-b', 'B', ${user}::uuid)`);
}, 120_000);

afterAll(async () => { await container?.stop(); }, 60_000);

beforeEach(reseed);

const mkSchema = async (id: string, project: string, slug: string) =>
  rootDb.execute(sql`INSERT INTO schemas (id, tenant_id, project_id, slug, display_name, created_by)
    VALUES (${id}::uuid, ${tenant}::uuid, ${project}::uuid, ${slug}, ${slug}, ${user}::uuid)`);
const mkPipeline = async (id: string, project: string, slug: string, opts: { schemaId?: string; modelProviderId?: string; parseProviderId?: string } = {}) =>
  rootDb.execute(sql`INSERT INTO pipelines (id, tenant_id, project_id, slug, display_name, schema_id, model_provider_id, parse_provider_id, created_by)
    VALUES (${id}::uuid, ${tenant}::uuid, ${project}::uuid, ${slug}, ${slug}, ${opts.schemaId ?? null}, ${opts.modelProviderId ?? null}, ${opts.parseProviderId ?? null}, ${user}::uuid)`);
const projectOf = async (table: string, id: string) => {
  const r = await rootDb.execute<{ project_id: string }>(sql.raw(`SELECT project_id FROM ${table} WHERE id = '${id}'`));
  return r[0]?.project_id ?? null;
};

describe("moveResource", () => {
  test("moves an unreferenced schema and reports moved", async () => {
    const s = randomUUID();
    await mkSchema(s, projA, "invoice");
    const res = await moveResource(db, tenant, "schema", s, projB);
    expect(res.status).toBe("moved");
    expect(await projectOf("schemas", s)).toBe(projB);
  });

  test("noop when already in the destination", async () => {
    const s = randomUUID();
    await mkSchema(s, projB, "invoice");
    expect((await moveResource(db, tenant, "schema", s, projB)).status).toBe("noop");
  });

  test("slug conflict when destination already has that slug", async () => {
    const s1 = randomUUID(), s2 = randomUUID();
    await mkSchema(s1, projA, "invoice");
    await mkSchema(s2, projB, "invoice");
    const res = await moveResource(db, tenant, "schema", s1, projB);
    expect(res.status).toBe("slug_conflict");
    expect(await projectOf("schemas", s1)).toBe(projA); // unchanged
  });

  test("blocks moving a schema still used by a pipeline in another project", async () => {
    const s = randomUUID(), p = randomUUID();
    await mkSchema(s, projA, "invoice");
    await mkPipeline(p, projA, "pipe", { schemaId: s });
    const res = await moveResource(db, tenant, "schema", s, projB);
    expect(res.status).toBe("blocked");
    if (res.status === "blocked") {
      expect(res.blockers).toEqual([{ type: "pipeline", slug: "pipe", reason: "uses this schema" }]);
    }
    expect(await projectOf("schemas", s)).toBe(projA);
  });

  test("moving a schema together with its pipeline (pipeline already moved) succeeds", async () => {
    const s = randomUUID(), p = randomUUID();
    await mkSchema(s, projA, "invoice");
    await mkPipeline(p, projB, "pipe", { schemaId: s }); // pipeline already in B
    // Now the schema is referenced only by a pipeline in B → moving S to B is unblocked.
    expect((await moveResource(db, tenant, "schema", s, projB)).status).toBe("moved");
  });

  test("blocks moving a pipeline whose schema/endpoint is in another project", async () => {
    const s = randomUUID(), p = randomUUID();
    await mkSchema(s, projA, "invoice");
    await mkPipeline(p, projA, "pipe", { schemaId: s });
    const res = await moveResource(db, tenant, "pipeline", p, projB);
    expect(res.status).toBe("blocked");
    if (res.status === "blocked") {
      expect(res.blockers.some((b) => b.type === "schema" && b.slug === "invoice")).toBe(true);
    }
  });

  test("moving a pipeline carries its jobs and their review items", async () => {
    const p = randomUUID(), job = randomUUID(), doc = randomUUID(), ri = randomUUID(), s = randomUUID();
    await mkSchema(s, projB, "invoice"); // schema already in B so the move isn't blocked
    await mkPipeline(p, projA, "pipe", { schemaId: s });
    await rootDb.execute(sql`INSERT INTO jobs (id, tenant_id, project_id, slug, pipeline_id, status, trigger_type)
      VALUES (${job}::uuid, ${tenant}::uuid, ${projA}::uuid, 'j', ${p}::uuid, 'complete', 'api')`);
    await rootDb.execute(sql`INSERT INTO documents (id, tenant_id, job_id, filename, storage_key, file_size, mime_type, content_hash, status)
      VALUES (${doc}::uuid, ${tenant}::uuid, ${job}::uuid, 'f.pdf', 'k', 1, 'application/pdf', repeat('a',64), 'delivered')`);
    await rootDb.execute(sql`INSERT INTO review_items (id, tenant_id, project_id, document_id, schema_id, field_name, reason)
      VALUES (${ri}::uuid, ${tenant}::uuid, ${projA}::uuid, ${doc}::uuid, ${s}::uuid, 'total', 'low_confidence')`);

    expect((await moveResource(db, tenant, "pipeline", p, projB)).status).toBe("moved");
    expect(await projectOf("pipelines", p)).toBe(projB);
    expect(await projectOf("jobs", job)).toBe(projB);
    expect(await projectOf("review_items", ri)).toBe(projB); // history followed
  });

  test("blocks moving a source whose target pipeline is in another project", async () => {
    const p = randomUUID(), src = randomUUID();
    await mkPipeline(p, projA, "pipe");
    await rootDb.execute(sql`INSERT INTO sources (id, tenant_id, project_id, slug, display_name, source_type, config_json, target_pipeline_id, created_by)
      VALUES (${src}::uuid, ${tenant}::uuid, ${projA}::uuid, 'src', 'Src', 'webhook', '{}', ${p}::uuid, ${user}::uuid)`);
    const res = await moveResource(db, tenant, "source", src, projB);
    expect(res.status).toBe("blocked");
  });

  test("moving a model endpoint also moves its paired provider credential", async () => {
    const ep = randomUUID();
    const cred = deriveCredentialId(ep);
    await rootDb.execute(sql`INSERT INTO model_endpoints (id, tenant_id, project_id, slug, display_name, provider, model, auth_json, config_json, created_by)
      VALUES (${ep}::uuid, ${tenant}::uuid, ${projA}::uuid, 'ep', 'EP', 'openai', 'gpt-4o-mini', '{}', '{}', ${user}::uuid)`);
    await rootDb.execute(sql`INSERT INTO provider_credentials (id, tenant_id, project_id, slug, display_name, provider, config_json, created_by)
      VALUES (${cred}::uuid, ${tenant}::uuid, ${projA}::uuid, 'ep', 'EP', 'openai', '{}', ${user}::uuid)`);
    expect((await moveResource(db, tenant, "model_endpoint", ep, projB)).status).toBe("moved");
    expect(await projectOf("model_endpoints", ep)).toBe(projB);
    expect(await projectOf("provider_credentials", cred)).toBe(projB); // paired credential followed
  });

  test("blocks moving a model endpoint still used by a pipeline elsewhere", async () => {
    const ep = randomUUID(), p = randomUUID();
    await rootDb.execute(sql`INSERT INTO model_endpoints (id, tenant_id, project_id, slug, display_name, provider, model, auth_json, config_json, created_by)
      VALUES (${ep}::uuid, ${tenant}::uuid, ${projA}::uuid, 'ep', 'EP', 'openai', 'gpt-4o-mini', '{}', '{}', ${user}::uuid)`);
    await mkPipeline(p, projA, "pipe", { modelProviderId: ep });
    expect((await moveResource(db, tenant, "model_endpoint", ep, projB)).status).toBe("blocked");
  });

  test("blocks moving a DAG pipeline whose schema (referenced by slug) isn't in the destination", async () => {
    // DAG pipelines reference schemas by slug in yaml, not the schemaId FK.
    const s = randomUUID(), p = randomUUID();
    await mkSchema(s, projA, "invoice");
    await rootDb.execute(sql`INSERT INTO pipelines (id, tenant_id, project_id, slug, display_name, pipeline_type, yaml_source, created_by)
      VALUES (${p}::uuid, ${tenant}::uuid, ${projA}::uuid, 'dag', 'DAG', 'dag', ${"pipeline: dag\nschema: invoice\n"}, ${user}::uuid)`);
    const res = await moveResource(db, tenant, "pipeline", p, projB);
    expect(res.status).toBe("blocked");
    if (res.status === "blocked") {
      expect(res.blockers.some((b) => b.type === "schema" && b.slug === "invoice")).toBe(true);
    }
  });

  test("blocks moving a schema out from under a DAG pipeline that references it by slug", async () => {
    const s = randomUUID(), p = randomUUID();
    await mkSchema(s, projA, "invoice");
    await rootDb.execute(sql`INSERT INTO pipelines (id, tenant_id, project_id, slug, display_name, pipeline_type, yaml_source, created_by)
      VALUES (${p}::uuid, ${tenant}::uuid, ${projA}::uuid, 'dag', 'DAG', 'dag', ${"pipeline: dag\nschema: invoice\n"}, ${user}::uuid)`);
    const res = await moveResource(db, tenant, "schema", s, projB);
    expect(res.status).toBe("blocked");
    if (res.status === "blocked") {
      expect(res.blockers).toEqual([{ type: "pipeline", slug: "dag", reason: "uses this schema" }]);
    }
  });

  test("slug conflict when the destination has a same-slug provider credential (paired-move collision)", async () => {
    // A standalone credential 'openai' in B with no live model_endpoint; moving
    // an endpoint 'openai' from A must be a clean slug_conflict, not a 500.
    const ep = randomUUID(), cred = deriveCredentialId(ep), otherCred = randomUUID();
    await rootDb.execute(sql`INSERT INTO model_endpoints (id, tenant_id, project_id, slug, display_name, provider, model, auth_json, config_json, created_by)
      VALUES (${ep}::uuid, ${tenant}::uuid, ${projA}::uuid, 'openai', 'EP', 'openai', 'gpt-4o-mini', '{}', '{}', ${user}::uuid)`);
    await rootDb.execute(sql`INSERT INTO provider_credentials (id, tenant_id, project_id, slug, display_name, provider, config_json, created_by)
      VALUES (${cred}::uuid, ${tenant}::uuid, ${projA}::uuid, 'openai', 'EP', 'openai', '{}', ${user}::uuid)`);
    await rootDb.execute(sql`INSERT INTO provider_credentials (id, tenant_id, project_id, slug, display_name, provider, config_json, created_by)
      VALUES (${otherCred}::uuid, ${tenant}::uuid, ${projB}::uuid, 'openai', 'Other', 'openai', '{}', ${user}::uuid)`);
    expect((await moveResource(db, tenant, "model_endpoint", ep, projB)).status).toBe("slug_conflict");
    expect(await projectOf("model_endpoints", ep)).toBe(projA); // unchanged
  });

  test("dry run reports the verdict without mutating", async () => {
    const s = randomUUID();
    await mkSchema(s, projA, "invoice");
    expect((await moveResource(db, tenant, "schema", s, projB, { dryRun: true })).status).toBe("moved");
    expect(await projectOf("schemas", s)).toBe(projA); // not actually moved
  });

  test("not_found for an unknown resource", async () => {
    expect((await moveResource(db, tenant, "schema", randomUUID(), projB)).status).toBe("not_found");
  });
});
