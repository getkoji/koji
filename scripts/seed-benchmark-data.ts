/**
 * Seed script: inserts realistic schema_runs data for the Performance page.
 *
 * Usage: npx tsx scripts/seed-benchmark-data.ts
 *
 * Generates 5 versions of validate runs with improving accuracy
 * and a small regression on v5 for total_premium.
 */

import { createDb, schema } from "@koji/db";
import { eq, desc } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/koji";
const db = createDb(DATABASE_URL);

const FIELD_SCORES: Record<string, number[]> = {
  insurer_name:          [88.2, 92.1, 95.3, 98.1, 98.0],
  named_insured:         [95.0, 96.4, 98.1, 99.2, 99.3],
  policy_number:         [90.1, 93.2, 96.0, 98.4, 97.8],
  policy_type:           [85.4, 90.0, 94.2, 97.1, 96.5],
  effective_date:        [94.3, 96.1, 97.4, 99.0, 99.1],
  expiration_date:       [93.0, 95.2, 97.0, 98.3, 98.2],
  total_premium:         [88.0, 91.3, 94.5, 99.4, 95.2], // regression at v5
  each_occurrence_limit: [90.4, 93.0, 95.8, 98.2, 98.0],
  general_aggregate:     [87.0, 90.4, 93.1, 96.8, 94.3],
};

const OVERALL = [92.4, 94.8, 96.7, 98.8, 98.5];

async function main() {
  console.log("Seeding benchmark data...");

  // Find the first tenant + schema
  const [tenant] = await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
  if (!tenant) { console.error("No tenant found. Run setup first."); process.exit(1); }

  const [firstSchema] = await db.select({ id: schema.schemas.id, slug: schema.schemas.slug })
    .from(schema.schemas).where(eq(schema.schemas.tenantId, tenant.id)).limit(1);
  if (!firstSchema) { console.error("No schema found. Create one first."); process.exit(1); }

  console.log(`  Tenant: ${tenant.id}`);
  console.log(`  Schema: ${firstSchema.slug} (${firstSchema.id})`);

  // Get existing schema versions
  const versions = await db.select({ id: schema.schemaVersions.id, versionNumber: schema.schemaVersions.versionNumber })
    .from(schema.schemaVersions)
    .where(eq(schema.schemaVersions.schemaId, firstSchema.id))
    .orderBy(schema.schemaVersions.versionNumber);

  if (versions.length === 0) { console.error("No schema versions found. Commit at least one version."); process.exit(1); }

  // We need 5 versions. If fewer exist, reuse the last one for remaining runs
  const versionIds = [];
  for (let i = 0; i < 5; i++) {
    versionIds.push(versions[Math.min(i, versions.length - 1)]!);
  }

  // Get a user for triggeredBy
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (!user) { console.error("No user found."); process.exit(1); }

  // Delete existing runs for this schema (clean slate)
  const existingRuns = await db.select({ id: schema.schemaRuns.id })
    .from(schema.schemaRuns).where(eq(schema.schemaRuns.schemaId, firstSchema.id));
  for (const r of existingRuns) {
    await db.delete(schema.corpusVersionResults).where(eq(schema.corpusVersionResults.runId, r.id));
  }
  await db.delete(schema.schemaRuns).where(eq(schema.schemaRuns.schemaId, firstSchema.id));

  // Create 5 validate runs
  const dates = [
    new Date("2026-03-28T10:00:00Z"),
    new Date("2026-04-02T10:00:00Z"),
    new Date("2026-04-07T10:00:00Z"),
    new Date("2026-04-12T10:00:00Z"),
    new Date("2026-04-17T10:00:00Z"),
  ];

  for (let i = 0; i < 5; i++) {
    const v = versionIds[i]!;
    const acc = OVERALL[i]! / 100;

    const [run] = await db.insert(schema.schemaRuns).values({
      tenantId: tenant.id,
      schemaId: firstSchema.id,
      schemaVersionId: v.id,
      runType: "validate",
      triggeredBy: user.id,
      triggeredReason: "manual",
      status: "completed",
      startedAt: dates[i],
      completedAt: new Date(dates[i]!.getTime() + 45000),
      docsTotal: 38,
      docsPassed: Math.round(38 * acc),
      docsFailed: 38 - Math.round(38 * acc),
      regressionsCount: i === 4 ? 2 : 0,
      accuracy: acc.toFixed(4),
      costUsd: (0.032 * 38).toFixed(6),
      durationMs: 45000,
      createdAt: dates[i],
    }).returning();

    console.log(`  Run ${i + 1}: v${v.versionNumber} → ${OVERALL[i]}% (${run!.id})`);
  }

  console.log("\nDone. Seed data inserted for Performance page.");
  process.exit(0);
}

main();
