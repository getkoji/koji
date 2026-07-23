/**
 * Soft-delete regression tests for provider resolution, against a real
 * Postgres (Testcontainers) — a mocked DB can't prove which row a join
 * actually returns, which is the entire bug.
 *
 * The shape reproduced here is one a production project reached by ordinary
 * use: add a credential, delete it, add another, delete that, add a third that
 * works. Delete stamps `deleted_at` and leaves `status = 'active'`, so a
 * resolver that filtered only on `status` kept every dead credential in the
 * candidate set — and the first one the planner returned won. The project's
 * settings page (which does filter deleted rows) showed the good key the whole
 * time, so "configured" and "actually used" silently disagreed.
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import { pickActiveTenantModel, resolveExtractEndpoint } from "./resolve-endpoint";
import { pickActiveParseEndpoint } from "../parse/resolve-tenant-parse";
import { encrypt } from "../crypto/envelope";

// A real master key + real ciphertext, so "deleted credentials don't resolve"
// is proven by the delete filter rather than by decryption happening to fail.
const MASTER_KEY = "a".repeat(64);
process.env.KOJI_MASTER_KEY = MASTER_KEY;

let container: StartedPostgreSqlContainer;
let rootDb: Db;
let db: Db; // app_user connection — RLS enforced, as in production

const tenant = randomUUID();
const user = randomUUID();
const project = randomUUID();
const otherProject = randomUUID();

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

  await rootDb.execute(
    sql`INSERT INTO tenants (id, slug, display_name) VALUES (${tenant}::uuid, 't', 'T')`,
  );
  await rootDb.execute(
    sql`INSERT INTO users (id, email, auth_provider, auth_provider_id)
        VALUES (${user}::uuid, 'u@x.com', 'local', 'u')`,
  );
  await rootDb.execute(sql`INSERT INTO projects (id, tenant_id, slug, display_name, created_by) VALUES
    (${project}::uuid, ${tenant}::uuid, 'quote', 'Quote', ${user}::uuid),
    (${otherProject}::uuid, ${tenant}::uuid, 'policy', 'Policy', ${user}::uuid)`);
}, 180_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await rootDb.execute(sql`SET client_min_messages = warning`);
  await rootDb.execute(
    sql`TRUNCATE tenant_models, provider_credentials, model_endpoints, parse_endpoints RESTART IDENTITY CASCADE`,
  );
});

/**
 * Insert a credential + one chat model. `deleted` stamps `deleted_at` on both
 * while leaving `status = 'active'` — exactly what DELETE
 * /api/model-providers/:id does. `withKey` mirrors a credential that was
 * stored without an API key (auth_json IS NULL).
 */
async function mkCredential(opts: {
  createdAt: string;
  deleted?: boolean;
  withKey?: boolean;
  projectId?: string | null;
}) {
  const credId = randomUUID();
  const modelId = randomUUID();
  const del = opts.deleted ? opts.createdAt : null;
  // `projectId: null` means shared with every project; omitted means the
  // default test project.
  const proj = opts.projectId === undefined ? project : opts.projectId;
  const auth =
    opts.withKey === false
      ? null
      : JSON.stringify({ key_hint: "AAAA", key_blob: encrypt("sk-live", MASTER_KEY, tenant) });
  await rootDb.execute(sql`
    INSERT INTO provider_credentials
      (id, tenant_id, project_id, slug, display_name, provider, config_json, auth_json, created_by, created_at, deleted_at)
    VALUES (${credId}::uuid, ${tenant}::uuid, ${proj}::uuid, ${credId.slice(0, 8)},
            'OpenAI', 'openai', '{}'::jsonb, ${auth}::jsonb, ${user}::uuid,
            ${opts.createdAt}::timestamptz, ${del}::timestamptz)
  `);
  await rootDb.execute(sql`
    INSERT INTO tenant_models
      (id, tenant_id, credential_id, model, capability, created_at, deleted_at)
    VALUES (${modelId}::uuid, ${tenant}::uuid, ${credId}::uuid, 'gpt-4o-mini', 'chat',
            ${opts.createdAt}::timestamptz, ${del}::timestamptz)
  `);
  return { credId, modelId };
}

const scope = () => ({ tenantId: tenant, projectId: project });

describe("pickActiveTenantModel — soft-deleted credentials", () => {
  test("skips deleted credentials and returns the live one", async () => {
    // Deleted-and-keyless first, exactly the production shape: it sorts first
    // by created_at, so an unfiltered query hands back the dead row.
    await mkCredential({ createdAt: "2026-07-23T20:10:00Z", deleted: true, withKey: false });
    await mkCredential({ createdAt: "2026-07-23T20:28:00Z", deleted: true });
    const live = await mkCredential({ createdAt: "2026-07-23T20:58:00Z" });

    expect(await pickActiveTenantModel(db, scope(), null)).toBe(live.modelId);
  });

  test("returns null when every credential in the project is deleted", async () => {
    await mkCredential({ createdAt: "2026-07-23T20:10:00Z", deleted: true });
    expect(await pickActiveTenantModel(db, scope(), null)).toBeNull();
  });

  test("a deleted credential is not resolvable even when pinned by id", async () => {
    // Holds a perfectly decryptable key — deleting it is the only reason it
    // must not resolve. A pipeline pinned to a credential the user threw away
    // has to stop using that key, not keep working off it.
    const dead = await mkCredential({ createdAt: "2026-07-23T20:10:00Z", deleted: true });
    expect(await resolveExtractEndpoint(db, scope(), dead.modelId)).toBeNull();

    const live = await mkCredential({ createdAt: "2026-07-23T20:58:00Z" });
    const payload = await resolveExtractEndpoint(db, scope(), live.modelId);
    expect(payload?.api_key).toBe("sk-live");
  });

  test("the pick is deterministic — oldest live credential wins", async () => {
    const first = await mkCredential({ createdAt: "2026-07-23T20:10:00Z" });
    await mkCredential({ createdAt: "2026-07-23T20:58:00Z" });
    expect(await pickActiveTenantModel(db, scope(), null)).toBe(first.modelId);
  });

  test("another project's live credential is never picked", async () => {
    await mkCredential({ createdAt: "2026-07-23T20:10:00Z", projectId: otherProject });
    expect(await pickActiveTenantModel(db, scope(), null)).toBeNull();
  });
});

describe("credential delete — every capability row goes with it", () => {
  test("a second capability row on the credential is soft-deleted too", async () => {
    // A credential created with capabilities ["chat","vision"] has a vision
    // row with a *fresh* id; the delete used to key on `id = endpointId` and
    // left it alive, pointing at a deleted credential.
    const { credId } = await mkCredential({ createdAt: "2026-07-23T20:28:00Z" });
    const visionId = randomUUID();
    await rootDb.execute(sql`
      INSERT INTO tenant_models (id, tenant_id, credential_id, model, capability)
      VALUES (${visionId}::uuid, ${tenant}::uuid, ${credId}::uuid, 'gpt-4o-mini', 'vision')
    `);

    // What DELETE /api/model-providers/:id now does.
    const now = new Date().toISOString();
    await rootDb.execute(
      sql`UPDATE tenant_models SET deleted_at = ${now}::timestamptz WHERE credential_id = ${credId}::uuid`,
    );
    await rootDb.execute(
      sql`UPDATE provider_credentials SET deleted_at = ${now}::timestamptz WHERE id = ${credId}::uuid`,
    );

    const orphans = await rootDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tenant_models tm
      JOIN provider_credentials pc ON pc.id = tm.credential_id
      WHERE tm.deleted_at IS NULL AND pc.deleted_at IS NOT NULL
    `);
    expect(orphans[0]?.n).toBe(0);
    expect(await pickActiveTenantModel(db, scope(), null)).toBeNull();
  });
});

describe("pickActiveParseEndpoint — soft-deleted endpoints", () => {
  async function mkParseEndpoint(opts: { createdAt: string; deleted?: boolean }) {
    const id = randomUUID();
    await rootDb.execute(sql`
      INSERT INTO parse_endpoints
        (id, tenant_id, project_id, slug, display_name, provider, model, config_json, created_by, created_at, deleted_at)
      VALUES (${id}::uuid, ${tenant}::uuid, ${project}::uuid, ${id.slice(0, 8)}, 'Doc AI',
              'google-docai', 'documentai', '{}'::jsonb, ${user}::uuid,
              ${opts.createdAt}::timestamptz, ${opts.deleted ? opts.createdAt : null}::timestamptz)
    `);
    return id;
  }

  test("skips deleted endpoints and returns the live one", async () => {
    await mkParseEndpoint({ createdAt: "2026-07-23T20:10:00Z", deleted: true });
    const live = await mkParseEndpoint({ createdAt: "2026-07-23T20:58:00Z" });
    expect(await pickActiveParseEndpoint(db, scope(), null)).toBe(live);
  });

  test("returns null when the only endpoint is deleted", async () => {
    await mkParseEndpoint({ createdAt: "2026-07-23T20:10:00Z", deleted: true });
    expect(await pickActiveParseEndpoint(db, scope(), null)).toBeNull();
  });
});

describe("scope precedence — project overrides workspace-shared", () => {
  /** A credential shared with every project (project_id IS NULL). */
  async function mkShared(createdAt: string) {
    return mkCredential({ createdAt, projectId: null as unknown as string });
  }

  test("a shared credential is resolvable from a project that has none of its own", async () => {
    const shared = await mkShared("2026-07-23T10:00:00Z");
    expect(await pickActiveTenantModel(db, scope(), null)).toBe(shared.modelId);
  });

  test("a project-scoped credential wins over a shared one, even when newer", async () => {
    await mkShared("2026-07-23T10:00:00Z");
    const own = await mkCredential({ createdAt: "2026-07-23T20:00:00Z" });
    expect(await pickActiveTenantModel(db, scope(), null)).toBe(own.modelId);
  });

  test("the override is per project — the other project still gets the shared one", async () => {
    const shared = await mkShared("2026-07-23T10:00:00Z");
    await mkCredential({ createdAt: "2026-07-23T20:00:00Z" });
    const other = await pickActiveTenantModel(
      db,
      { tenantId: tenant, projectId: otherProject },
      null,
    );
    expect(other).toBe(shared.modelId);
  });

  test("deleting the project override falls back to the shared credential", async () => {
    const shared = await mkShared("2026-07-23T10:00:00Z");
    const own = await mkCredential({ createdAt: "2026-07-23T20:00:00Z" });
    expect(await pickActiveTenantModel(db, scope(), null)).toBe(own.modelId);

    await rootDb.execute(
      sql`UPDATE provider_credentials SET deleted_at = now() WHERE id = ${own.credId}::uuid`,
    );
    await rootDb.execute(
      sql`UPDATE tenant_models SET deleted_at = now() WHERE credential_id = ${own.credId}::uuid`,
    );
    expect(await pickActiveTenantModel(db, scope(), null)).toBe(shared.modelId);
  });
});
