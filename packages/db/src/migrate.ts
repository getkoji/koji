/**
 * Migration runner for the @koji/db package.
 *
 * Applies the Drizzle-generated CREATE TABLE migrations then the hand-written
 * RLS policy migration (`drizzle/0001_rls.sql`). Drizzle Kit does not emit
 * `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` statements, so the RLS file is
 * applied separately.
 *
 * Usage:
 *
 *     DATABASE_URL=postgres://... pnpm --filter @koji/db migrate
 *
 * Re-runs are safe. Drizzle's own CREATE TABLE statements are idempotent, and
 * the hand-written RLS file pairs every CREATE POLICY with a preceding
 * DROP POLICY IF EXISTS so repeat runs drop-and-recreate cleanly. (Postgres
 * does NOT support `CREATE POLICY IF NOT EXISTS`; the drop/create dance is
 * the idiomatic workaround.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = resolve(__dirname, "..", "drizzle");

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const db = drizzle(client);
    await drizzleMigrate(db, { migrationsFolder });
    const rlsPath = resolve(migrationsFolder, "0001_rls.sql");
    const rlsSql = readFileSync(rlsPath, "utf8");
    await client.unsafe(rlsSql);
    await provisionAppUser(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Ensure the runtime `app_user` role exists with the grants the API
 * needs to run under RLS.
 *
 * The Postgres container also runs `docker/db-init/01_app_user.sql`
 * via docker-entrypoint-initdb.d, but that only fires on FIRST boot
 * (empty pgdata volume). Running the same provisioning here on every
 * migrate call guarantees the role exists regardless of how the DB
 * was initialised — important for existing dev volumes from before
 * this change landed, and for managed Postgres where there is no
 * docker init hook.
 *
 * Silently tolerates "permission denied" in cases where the migrate
 * user isn't a superuser (managed Postgres typically forbids
 * CREATE ROLE to non-admins). In that environment, ops is expected
 * to provision `app_user` out-of-band; this function is a best-effort
 * convenience for self-hosted + local setups.
 */
async function provisionAppUser(
  client: ReturnType<typeof postgres>,
): Promise<void> {
  try {
    await client.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE;
        END IF;
      END $$;

      GRANT USAGE ON SCHEMA public TO app_user;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO app_user;
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission denied|must be superuser|cannot be granted/i.test(msg)) {
      console.warn(
        `[migrate] app_user provisioning skipped (${msg}). ` +
          "Provision the role out-of-band — see packages/db/README.md.",
      );
      return;
    }
    throw err;
  }
}

// Run when invoked directly (not imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  runMigrations(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
