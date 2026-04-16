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
 * Re-runs are safe: `CREATE TABLE IF NOT EXISTS` and `CREATE POLICY IF NOT
 * EXISTS` make every statement idempotent (with the caveat that altering an
 * existing table or policy requires a new migration, not a re-run of this one).
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
  } finally {
    await client.end({ timeout: 5 });
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
