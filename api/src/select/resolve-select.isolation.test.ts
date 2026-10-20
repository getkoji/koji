/**
 * Cross-tenant isolation for selector resolution, against a real Postgres.
 *
 * `pickSelectEndpoint` is a new tenant-scoped query, and every tenant-scoped
 * query needs a cross-tenant isolation test. A mocked DB cannot provide one:
 * the thing at risk is *which row a join actually returns*, and a mock returns
 * whatever the test told it to. So this spins up Postgres, applies the real
 * migration stream, seeds a selector credential for two tenants, and asserts
 * that tenant A's scope can never reach tenant B's selector or its key — and
 * the reverse.
 *
 * It also covers the project-scoping and soft-delete rules the selector query
 * inherits from the rest of credential resolution, because a resolver that
 * respects tenant boundaries and then hands back a deleted credential is still
 * handing back the wrong key.
 */

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import { encrypt } from "../crypto/envelope";
import { pickSelectEndpoint } from "./resolve-select";
import { resolveExtractEndpoint } from "../extract/resolve-endpoint";

const MASTER_KEY = "b".repeat(64);
process.env.KOJI_MASTER_KEY = MASTER_KEY;

let container: StartedPostgreSqlContainer;
let rootDb: Db;
/** app_user connection — RLS enforced, as in production. */
let db: Db;

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const projectA = randomUUID();
const projectA2 = randomUUID();
const projectB = randomUUID();

/** The secrets each tenant's selector credential holds. Never crossed. */
const KEY_A = "ts-key-tenant-a";
const KEY_B = "ts-key-tenant-b";

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
  db = createDb(rootUrl.replace("postgres://postgres:postgres@", "postgres://app_user:app_user@"), {
    max: 5,
  });

  await rootDb.execute(sql`INSERT INTO tenants (id, slug, display_name) VALUES
    (${tenantA}::uuid, 'tenant-a', 'Tenant A'),
    (${tenantB}::uuid, 'tenant-b', 'Tenant B')`);
  await rootDb.execute(sql`INSERT INTO users (id, email, auth_provider, auth_provider_id) VALUES
    (${userA}::uuid, 'a@x.com', 'local', 'a'),
    (${userB}::uuid, 'b@x.com', 'local', 'b')`);
  await rootDb.execute(sql`INSERT INTO projects (id, tenant_id, slug, display_name, created_by) VALUES
    (${projectA}::uuid, ${tenantA}::uuid, 'quote', 'Quote', ${userA}::uuid),
    (${projectA2}::uuid, ${tenantA}::uuid, 'policy', 'Policy', ${userA}::uuid),
    (${projectB}::uuid, ${tenantB}::uuid, 'quote', 'Quote', ${userB}::uuid)`);
}, 240_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await rootDb.execute(sql`SET client_min_messages = warning`);
  await rootDb.execute(
    sql`TRUNCATE tenant_models, provider_credentials RESTART IDENTITY CASCADE`,
  );
});

/**
 * Insert a credential plus one model row. Inserted as the owner role so the
 * fixture itself is not what RLS is being tested through — only the reads are.
 */
async function seedSelector(opts: {
  tenant: string;
  user: string;
  projectId: string | null;
  provider: string;
  capability: string;
  model: string;
  apiKey: string;
  createdAt?: string;
  deleted?: boolean;
}): Promise<{ credentialId: string; modelId: string }> {
  const credentialId = randomUUID();
  const modelId = randomUUID();
  const createdAt = opts.createdAt ?? "2026-01-01T00:00:00Z";
  const deletedAt = opts.deleted ? createdAt : null;
  const auth = JSON.stringify({
    key_hint: opts.apiKey.slice(0, 4),
    key_blob: encrypt(opts.apiKey, MASTER_KEY, opts.tenant),
  });
  await rootDb.execute(sql`
    INSERT INTO provider_credentials
      (id, tenant_id, project_id, slug, display_name, provider, config_json, auth_json,
       created_by, created_at, deleted_at)
    VALUES (${credentialId}::uuid, ${opts.tenant}::uuid, ${opts.projectId}::uuid,
            ${credentialId.slice(0, 8)}, ${opts.provider}, ${opts.provider}, '{}'::jsonb,
            ${auth}::jsonb, ${opts.user}::uuid, ${createdAt}::timestamptz,
            ${deletedAt}::timestamptz)
  `);
  await rootDb.execute(sql`
    INSERT INTO tenant_models
      (id, tenant_id, credential_id, model, capability, created_at, deleted_at)
    VALUES (${modelId}::uuid, ${opts.tenant}::uuid, ${credentialId}::uuid, ${opts.model},
            ${opts.capability}, ${createdAt}::timestamptz, ${deletedAt}::timestamptz)
  `);
  return { credentialId, modelId };
}

describe("pickSelectEndpoint — cross-tenant isolation", () => {
  test("each tenant resolves only its own selector", async () => {
    const a = await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_A,
    });
    const b = await seedSelector({
      tenant: tenantB,
      user: userB,
      projectId: projectB,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_B,
    });

    const forA = await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectA });
    const forB = await pickSelectEndpoint(db, { tenantId: tenantB, projectId: projectB });

    expect(forA?.id).toBe(a.modelId);
    expect(forB?.id).toBe(b.modelId);
    expect(forA?.id).not.toBe(b.modelId);
    expect(forB?.id).not.toBe(a.modelId);
  });

  test("a tenant with no selector of its own resolves nothing, never the neighbour's", async () => {
    await seedSelector({
      tenant: tenantB,
      user: userB,
      projectId: projectB,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_B,
    });
    expect(await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectA })).toBeNull();
  });

  test("a tenant-only scope is isolated too, not just a project scope", async () => {
    const a = await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: null,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_A,
    });
    await seedSelector({
      tenant: tenantB,
      user: userB,
      projectId: null,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_B,
    });
    expect((await pickSelectEndpoint(db, tenantA))?.id).toBe(a.modelId);
  });

  test("a connection that never set a tenant gets no selector row at all", async () => {
    await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_A,
    });

    // The safe default, asserted as an outcome rather than a mechanism. On this
    // join the observed behaviour is that the query *errors* — the project
    // policy casts an unset `app.current_project_id` to uuid and Postgres
    // rejects the empty string — rather than returning zero rows the way a
    // single-table select on `schemas` does. Both are safe; what must never
    // happen is a row coming back, so that is what is checked.
    let rows: unknown[] | null = null;
    try {
      rows = await db.execute(
        sql.raw(
          "SELECT tm.id FROM tenant_models tm JOIN provider_credentials pc ON pc.id = tm.credential_id",
        ),
      );
    } catch {
      rows = null;
    }
    expect(rows === null || rows.length === 0).toBe(true);
  });

  test("tenant A's scope naming tenant B's project yields nothing", async () => {
    await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_A,
    });
    await seedSelector({
      tenant: tenantB,
      user: userB,
      projectId: projectB,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_B,
    });
    expect(await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectB })).toBeNull();
  });

  test("the decrypted key never crosses a tenant boundary", async () => {
    const a = await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_A,
    });
    const b = await seedSelector({
      tenant: tenantB,
      user: userB,
      projectId: projectB,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_B,
    });

    const payloadA = await resolveExtractEndpoint(
      db,
      { tenantId: tenantA, projectId: projectA },
      a.modelId,
    );
    expect(payloadA?.api_key).toBe(KEY_A);

    // Tenant A naming tenant B's model id resolves nothing at all: RLS filters
    // the row out before the envelope is ever reached, so there is no
    // ciphertext to attempt and no key to leak.
    expect(
      await resolveExtractEndpoint(db, { tenantId: tenantA, projectId: projectA }, b.modelId),
    ).toBeNull();
    expect(
      await resolveExtractEndpoint(db, { tenantId: tenantB, projectId: projectB }, a.modelId),
    ).toBeNull();
  });
});

describe("pickSelectEndpoint — selection rules", () => {
  test("ignores a model tagged for another capability", async () => {
    await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "openai",
      capability: "chat",
      model: "gpt-4o-mini",
      apiKey: KEY_A,
    });
    expect(await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectA })).toBeNull();
  });

  test("ignores a soft-deleted selector", async () => {
    await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_A,
      deleted: true,
    });
    expect(await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectA })).toBeNull();
  });

  test("prefers a project-scoped selector over a workspace-shared one", async () => {
    await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: null,
      provider: "typesafe",
      capability: "select",
      model: "shared",
      apiKey: KEY_A,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const scoped = await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "laya",
      capability: "select",
      model: "scoped",
      apiKey: KEY_A,
      createdAt: "2026-02-01T00:00:00Z",
    });

    const forA = await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectA });
    expect(forA?.id).toBe(scoped.modelId);
    expect(forA?.provider).toBe("laya");

    // The sibling project has no override of its own, so it keeps the shared one.
    const forA2 = await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectA2 });
    expect(forA2?.model).toBe("shared");
  });

  test("reports the credential's provider, which is what names the implementation", async () => {
    await seedSelector({
      tenant: tenantA,
      user: userA,
      projectId: projectA,
      provider: "typesafe",
      capability: "select",
      model: "jev-latest",
      apiKey: KEY_A,
    });
    const row = await pickSelectEndpoint(db, { tenantId: tenantA, projectId: projectA });
    expect(row).toMatchObject({ provider: "typesafe", model: "jev-latest" });
  });
});
