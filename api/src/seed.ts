/**
 * Seed the database with sample data for development.
 *
 * Usage: DATABASE_URL=postgres://koji:koji@localhost:5433/koji pnpm --filter @koji/api seed
 */
import { sql } from "drizzle-orm";
import { createDb, schema } from "@koji/db";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://koji:koji@localhost:5433/koji";
const TENANT = "00000000-0000-0000-0000-000000000000";
const USER = "00000000-0000-0000-0000-000000000001";

const db = createDb(DATABASE_URL);

async function seed() {
  console.log("Seeding...");

  // Create schemas
  const [invoiceSchema] = await db.insert(schema.schemas).values([
    { tenantId: TENANT, slug: "invoice", displayName: "Invoice", description: "Commercial invoice extraction — number, dates, parties, line items, totals.", createdBy: USER },
    { tenantId: TENANT, slug: "receipt", displayName: "Receipt", description: "POS receipt extraction — store, date, items, total.", createdBy: USER },
    { tenantId: TENANT, slug: "insurance-claim", displayName: "Insurance Claim", description: "First notice of loss — claimant, policy, incident, damages.", createdBy: USER },
  ]).returning();
  console.log("  3 schemas created");

  // Create pipelines
  const [claimsPipeline] = await db.insert(schema.pipelines).values([
    { tenantId: TENANT, slug: "claims-intake", displayName: "Claims Intake", yamlSource: "step: extract", parsedJson: {}, triggerType: "webhook", triggerConfigJson: {}, status: "active", createdBy: USER },
    { tenantId: TENANT, slug: "invoice-ingest", displayName: "Invoice Ingest", yamlSource: "step: extract", parsedJson: {}, triggerType: "s3_watcher", triggerConfigJson: {}, status: "active", createdBy: USER },
    { tenantId: TENANT, slug: "receipt-scan", displayName: "Receipt Scan", yamlSource: "step: extract", parsedJson: {}, triggerType: "manual", triggerConfigJson: {}, status: "active", createdBy: USER },
  ]).returning();
  console.log("  3 pipelines created");

  // Create jobs
  const jobData = [
    { slug: "job-20260414-1442-a91c", pipeline: claimsPipeline!.id, status: "complete", total: 47, processed: 47, passed: 46, failed: 1, latency: 2300, cost: "0.042", trigger: "webhook", ago: 2 },
    { slug: "job-20260414-0903-b2df", pipeline: claimsPipeline!.id, status: "running", total: 24, processed: 12, passed: 12, failed: 0, latency: 1800, cost: "0.011", trigger: "webhook", ago: 18 },
    { slug: "job-20260413-2201-c4e1", pipeline: claimsPipeline!.id, status: "failed", total: 3, processed: 1, passed: 0, failed: 1, latency: null, cost: "0.001", trigger: "manual", ago: 60 },
    { slug: "job-20260413-1442-f891", pipeline: claimsPipeline!.id, status: "complete", total: 89, processed: 89, passed: 88, failed: 1, latency: 1950, cost: "0.079", trigger: "scheduled", ago: 180 },
    { slug: "job-20260413-1100-d234", pipeline: claimsPipeline!.id, status: "complete", total: 52, processed: 52, passed: 51, failed: 1, latency: 2100, cost: "0.048", trigger: "webhook", ago: 300 },
    { slug: "job-20260412-1830-e567", pipeline: claimsPipeline!.id, status: "complete", total: 31, processed: 31, passed: 31, failed: 0, latency: 1700, cost: "0.029", trigger: "s3_watcher", ago: 1440 },
    { slug: "job-20260412-0900-a123", pipeline: claimsPipeline!.id, status: "canceled", total: 0, processed: 0, passed: 0, failed: 0, latency: null, cost: "0.000", trigger: "manual", ago: 1800 },
    { slug: "job-20260411-1400-b456", pipeline: claimsPipeline!.id, status: "complete", total: 64, processed: 64, passed: 63, failed: 1, latency: 2200, cost: "0.058", trigger: "webhook", ago: 2880 },
    { slug: "job-20260410-0800-c789", pipeline: claimsPipeline!.id, status: "complete", total: 112, processed: 112, passed: 110, failed: 2, latency: 2400, cost: "0.103", trigger: "scheduled", ago: 4320 },
    { slug: "job-20260409-1600-d012", pipeline: claimsPipeline!.id, status: "complete", total: 28, processed: 28, passed: 28, failed: 0, latency: 1600, cost: "0.025", trigger: "webhook", ago: 5760 },
  ];

  for (const j of jobData) {
    const now = new Date();
    const startedAt = new Date(now.getTime() - j.ago * 60 * 1000);
    const completedAt = j.status === "running" ? null : new Date(startedAt.getTime() + (j.latency ?? 0));

    await db.insert(schema.jobs).values({
      tenantId: TENANT,
      slug: j.slug,
      pipelineId: j.pipeline,
      triggerType: j.trigger,
      status: j.status,
      docsTotal: j.total,
      docsProcessed: j.processed,
      docsPassed: j.passed,
      docsFailed: j.failed,
      avgLatencyMs: j.latency,
      totalCostUsd: j.cost,
      startedAt,
      completedAt,
    });
  }
  console.log(`  ${jobData.length} jobs created`);

  console.log("Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
