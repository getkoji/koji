/**
 * Seed the database with sample data for development.
 *
 * Usage: DATABASE_URL=postgres://koji:koji@localhost:5433/koji pnpm --filter @koji/api seed
 */
import crypto from "node:crypto";
import { createDb, schema } from "@koji/db";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://koji:koji@localhost:5433/koji";

const db = createDb(DATABASE_URL);

async function seed() {
  console.log("Seeding...");

  // Resolve tenant + user from whatever the setup flow produced
  const [tenantRow] = await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
  const [userRow] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (!tenantRow || !userRow) {
    console.error("No tenant/user found. Complete /setup first.");
    process.exit(1);
  }
  const TENANT = tenantRow.id;
  const USER = userRow.id;
  console.log(`  tenant=${TENANT}`);
  console.log(`  user=${USER}`);

  // ── Schemas ──
  const [invoiceSchema, receiptSchema, claimSchema] = await db
    .insert(schema.schemas)
    .values([
      { tenantId: TENANT, slug: "invoice", displayName: "Invoice", description: "Commercial invoice extraction — number, dates, parties, line items, totals.", createdBy: USER },
      { tenantId: TENANT, slug: "receipt", displayName: "Receipt", description: "POS receipt extraction — store, date, items, total.", createdBy: USER },
      { tenantId: TENANT, slug: "insurance-claim", displayName: "Insurance Claim", description: "First notice of loss — claimant, policy, incident, damages.", createdBy: USER },
    ])
    .returning();
  console.log("  3 schemas created");

  // ── Schema versions (one deployed version per schema) ──
  const invoiceYaml = "fields:\n  invoice_number: string\n  total: number\n";
  const receiptYaml = "fields:\n  store: string\n  total: number\n";
  const claimYaml = "fields:\n  claimant: string\n  policy_number: string\n";
  const [invoiceVersion, receiptVersion, claimVersion] = await db
    .insert(schema.schemaVersions)
    .values([
      {
        tenantId: TENANT,
        schemaId: invoiceSchema!.id,
        versionNumber: 12,
        yamlSource: invoiceYaml,
        yamlHash: crypto.createHash("sha256").update(invoiceYaml).digest("hex"),
        parsedJson: { fields: { invoice_number: "string", total: "number" } },
        commitMessage: "Initial invoice schema",
        committedBy: USER,
      },
      {
        tenantId: TENANT,
        schemaId: receiptSchema!.id,
        versionNumber: 3,
        yamlSource: receiptYaml,
        yamlHash: crypto.createHash("sha256").update(receiptYaml).digest("hex"),
        parsedJson: { fields: { store: "string", total: "number" } },
        commitMessage: "Initial receipt schema",
        committedBy: USER,
      },
      {
        tenantId: TENANT,
        schemaId: claimSchema!.id,
        versionNumber: 4,
        yamlSource: claimYaml,
        yamlHash: crypto.createHash("sha256").update(claimYaml).digest("hex"),
        parsedJson: { fields: { claimant: "string", policy_number: "string" } },
        commitMessage: "Initial claim schema",
        committedBy: USER,
      },
    ])
    .returning();

  console.log("  3 schema versions created");

  // ── Model endpoints (pipelines reference these via model_provider_id) ──
  const [openaiEndpoint, anthropicEndpoint] = await db
    .insert(schema.modelEndpoints)
    .values([
      {
        tenantId: TENANT,
        slug: "openai-primary",
        displayName: "OpenAI primary",
        provider: "openai",
        model: "gpt-4o-mini",
        configJson: { api_base: "https://api.openai.com/v1" },
        status: "active",
        createdBy: USER,
      },
      {
        tenantId: TENANT,
        slug: "anthropic-fallback",
        displayName: "Anthropic fallback",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        configJson: {},
        status: "active",
        createdBy: USER,
      },
    ])
    .returning();
  console.log("  2 model endpoints created");

  // ── Pipelines (each wired to a schema + its deployed version + a model) ──
  const [claimsPipeline, invoicePipeline, receiptPipeline] = await db
    .insert(schema.pipelines)
    .values([
      {
        tenantId: TENANT,
        slug: "claims-intake",
        displayName: "Claims Intake",
        schemaId: claimSchema!.id,
        activeSchemaVersionId: claimVersion!.id,
        modelProviderId: openaiEndpoint!.id,
        reviewThreshold: "0.85",
        configJson: {
          stages: {
            preflight: { max_pages: 20, max_size_mb: 10 },
            chunker: { strategy: "page" },
            validator: { strictness: "normal" },
          },
        },
        yamlSource: "step: extract",
        parsedJson: {},
        triggerType: "webhook",
        triggerConfigJson: {},
        status: "active",
        createdBy: USER,
      },
      {
        tenantId: TENANT,
        slug: "invoice-ingest",
        displayName: "Invoice Ingest",
        schemaId: invoiceSchema!.id,
        activeSchemaVersionId: invoiceVersion!.id,
        modelProviderId: openaiEndpoint!.id,
        reviewThreshold: "0.90",
        configJson: {
          stages: {
            preflight: { max_pages: 50, max_size_mb: 25 },
            chunker: { strategy: "semantic" },
            validator: { strictness: "strict" },
          },
        },
        yamlSource: "step: extract",
        parsedJson: {},
        triggerType: "s3_watcher",
        triggerConfigJson: { bucket: "acme-invoices-inbound" },
        status: "active",
        createdBy: USER,
      },
      {
        tenantId: TENANT,
        slug: "receipt-scan",
        displayName: "Receipt Scan",
        schemaId: receiptSchema!.id,
        activeSchemaVersionId: receiptVersion!.id,
        modelProviderId: anthropicEndpoint!.id,
        reviewThreshold: "0.80",
        configJson: {
          stages: {
            preflight: { max_pages: 5, max_size_mb: 5 },
            chunker: { strategy: "whole" },
          },
        },
        yamlSource: "step: extract",
        parsedJson: {},
        triggerType: "manual",
        triggerConfigJson: {},
        status: "paused",
        createdBy: USER,
      },
    ])
    .returning();
  console.log("  3 pipelines created");

  // ── Sources — at least one per pipeline so the detail page's
  //    "Connected sources" section has real rows ──
  await db.insert(schema.sources).values([
    {
      tenantId: TENANT,
      slug: "acme-invoices-inbound",
      displayName: "acme-invoices-inbound",
      sourceType: "s3",
      configJson: { bucket: "acme-invoices-inbound", region: "us-east-1", prefix: "incoming/" },
      targetPipelineId: invoicePipeline!.id,
      status: "active",
      lastIngestedAt: new Date(Date.now() - 30 * 60 * 1000),
      createdBy: USER,
    },
    {
      tenantId: TENANT,
      slug: "partner-claims-webhook",
      displayName: "Partner claims webhook",
      sourceType: "webhook",
      configJson: { path: "/api/sources/partner-claims-webhook/webhook" },
      targetPipelineId: claimsPipeline!.id,
      status: "active",
      lastIngestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      webhookSecret: "whsec_seed_claims",
      createdBy: USER,
    },
    {
      tenantId: TENANT,
      slug: "receipts-inbox",
      displayName: "Receipts inbox",
      sourceType: "email",
      configJson: { address: "receipts@inbound.getkoji.dev" },
      targetPipelineId: null,
      status: "paused",
      lastIngestedAt: null,
      createdBy: USER,
    },
  ]);
  console.log("  3 sources created");

  // ── Jobs — spread across pipelines so the list is realistic ──
  type JobSeed = {
    slug: string;
    pipeline: string;
    status: "complete" | "running" | "failed" | "canceled";
    total: number;
    processed: number;
    passed: number;
    failed: number;
    reviewing?: number;
    latency: number | null;
    cost: string;
    trigger: string;
    ago: number;
  };

  const jobData: JobSeed[] = [
    { slug: "job-20260420-1430", pipeline: invoicePipeline!.id, status: "running", total: 142, processed: 48, passed: 47, failed: 0, reviewing: 1, latency: 1850, cost: "0.056", trigger: "scheduled", ago: 2 },
    { slug: "job-20260420-0900", pipeline: invoicePipeline!.id, status: "complete", total: 142, processed: 142, passed: 142, failed: 0, reviewing: 0, latency: 1920, cost: "0.167", trigger: "scheduled", ago: 180 },
    { slug: "job-20260420-0600", pipeline: invoicePipeline!.id, status: "complete", total: 238, processed: 238, passed: 237, failed: 0, reviewing: 1, latency: 2050, cost: "0.283", trigger: "scheduled", ago: 360 },
    { slug: "job-20260419-2144", pipeline: invoicePipeline!.id, status: "complete", total: 5, processed: 5, passed: 5, failed: 0, reviewing: 0, latency: 1200, cost: "0.006", trigger: "manual", ago: 1020 },
    { slug: "job-20260419-1800", pipeline: claimsPipeline!.id, status: "canceled", total: 62, processed: 14, passed: 14, failed: 0, reviewing: 0, latency: 2100, cost: "0.019", trigger: "manual", ago: 1320 },
    { slug: "job-20260419-1200", pipeline: claimsPipeline!.id, status: "failed", total: 28, processed: 28, passed: 25, failed: 3, reviewing: 0, latency: 2400, cost: "0.042", trigger: "webhook", ago: 1680 },
    { slug: "job-20260418-1442", pipeline: invoicePipeline!.id, status: "complete", total: 218, processed: 218, passed: 218, failed: 0, reviewing: 0, latency: 1890, cost: "0.248", trigger: "scheduled", ago: 2880 },
    { slug: "job-20260418-1200", pipeline: invoicePipeline!.id, status: "complete", total: 194, processed: 194, passed: 193, failed: 1, reviewing: 0, latency: 1950, cost: "0.219", trigger: "scheduled", ago: 3120 },
    { slug: "job-20260418-0900", pipeline: receiptPipeline!.id, status: "complete", total: 62, processed: 62, passed: 62, failed: 0, reviewing: 0, latency: 1450, cost: "0.052", trigger: "scheduled", ago: 3420 },
    { slug: "job-20260417-1442", pipeline: invoicePipeline!.id, status: "complete", total: 251, processed: 251, passed: 251, failed: 0, reviewing: 0, latency: 1920, cost: "0.285", trigger: "scheduled", ago: 4320 },
  ];

  const jobsInserted = await db
    .insert(schema.jobs)
    .values(
      jobData.map((j) => {
        const now = new Date();
        const startedAt = new Date(now.getTime() - j.ago * 60 * 1000);
        const completedAt = j.status === "running" ? null : new Date(startedAt.getTime() + (j.latency ?? 0));
        return {
          tenantId: TENANT,
          slug: j.slug,
          pipelineId: j.pipeline,
          triggerType: j.trigger,
          status: j.status,
          docsTotal: j.total,
          docsProcessed: j.processed,
          docsPassed: j.passed,
          docsFailed: j.failed,
          docsReviewing: j.reviewing ?? 0,
          avgLatencyMs: j.latency,
          totalCostUsd: j.cost,
          startedAt,
          completedAt,
        };
      }),
    )
    .returning({ id: schema.jobs.id, slug: schema.jobs.slug });
  console.log(`  ${jobData.length} jobs created`);

  // ── Documents — seed a handful per job so the detail page has real rows ──
  const jobBySlug = new Map(jobsInserted.map((r) => [r.slug, r.id]));
  const pipelineSchemaMap = new Map([
    [invoicePipeline!.id, { schemaId: invoiceSchema!.id, versionId: invoiceVersion!.id }],
    [claimsPipeline!.id, { schemaId: claimSchema!.id, versionId: claimVersion!.id }],
    [receiptPipeline!.id, { schemaId: receiptSchema!.id, versionId: receiptVersion!.id }],
  ]);

  type DocSeed = { job: string; pipelineId: string; filename: string; status: string; confidence?: string | null; durationMs?: number | null; validation?: unknown; extraction?: unknown };
  const docSeeds: DocSeed[] = [];

  function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function conf(lo: number, hi: number) { return (lo + Math.random() * (hi - lo)).toFixed(4); }

  // Running job — 48 processed so far, 1 in review
  pushDocs("job-20260420-1430", invoicePipeline!.id, "invoice", 8, "delivered", { lo: 0.96, hi: 0.99 }, 1);
  pushDocs("job-20260420-1430", invoicePipeline!.id, "invoice", 1, "review", { lo: 0.72, hi: 0.82 }, 47, { reason: "low_confidence" });
  pushDocs("job-20260420-1430", invoicePipeline!.id, "invoice", 3, "extracting", null, 49);

  // Completed clean — show top 10
  pushDocs("job-20260420-0900", invoicePipeline!.id, "invoice", 10, "delivered", { lo: 0.97, hi: 0.99 }, 1);

  // Completed with one review
  pushDocs("job-20260420-0600", invoicePipeline!.id, "invoice", 1, "review", { lo: 0.70, hi: 0.78 }, 87, { reason: "low_confidence" });
  pushDocs("job-20260420-0600", invoicePipeline!.id, "invoice", 9, "delivered", { lo: 0.96, hi: 0.99 }, 1);

  // Small ad-hoc run
  pushDocs("job-20260419-2144", invoicePipeline!.id, "invoice", 5, "delivered", { lo: 0.98, hi: 0.99 }, 1);

  // Cancelled — 14 delivered
  pushDocs("job-20260419-1800", claimsPipeline!.id, "claim", 6, "delivered", { lo: 0.94, hi: 0.99 }, 1);

  // Failed job — 3 failed with different error causes
  pushDocs("job-20260419-1200", claimsPipeline!.id, "claim", 1, "failed", null, 12, { error_cause: "chunker_error", message: "Document could not be chunked" });
  pushDocs("job-20260419-1200", claimsPipeline!.id, "claim", 1, "failed", null, 19, { error_cause: "validation_failed", message: "Required field 'policy_number' missing" });
  pushDocs("job-20260419-1200", claimsPipeline!.id, "claim", 1, "failed", null, 25, { error_cause: "retries_exhausted", message: "Model timed out after 3 attempts" });
  pushDocs("job-20260419-1200", claimsPipeline!.id, "claim", 10, "delivered", { lo: 0.93, hi: 0.98 }, 1);

  // Older completes — 6 docs each so the detail page has content
  pushDocs("job-20260418-1442", invoicePipeline!.id, "invoice", 6, "delivered", { lo: 0.96, hi: 0.99 }, 1);
  pushDocs("job-20260418-1200", invoicePipeline!.id, "invoice", 1, "review", { lo: 0.72, hi: 0.82 }, 1, { reason: "mandatory_field_review" });
  pushDocs("job-20260418-1200", invoicePipeline!.id, "invoice", 5, "delivered", { lo: 0.96, hi: 0.99 }, 2);
  pushDocs("job-20260418-0900", receiptPipeline!.id, "receipt", 6, "delivered", { lo: 0.95, hi: 0.99 }, 1);
  pushDocs("job-20260417-1442", invoicePipeline!.id, "invoice", 6, "delivered", { lo: 0.97, hi: 0.99 }, 1);

  function pushDocs(
    jobSlug: string,
    pipelineId: string,
    prefix: string,
    count: number,
    status: string,
    confRange: { lo: number; hi: number } | null,
    startIndex: number,
    validation?: unknown,
  ) {
    for (let i = 0; i < count; i++) {
      const idx = startIndex + i;
      docSeeds.push({
        job: jobSlug,
        pipelineId,
        filename: `${prefix}-${idx.toString().padStart(4, "0")}.pdf`,
        status,
        confidence: confRange ? conf(confRange.lo, confRange.hi) : null,
        durationMs: status === "extracting" ? null : rand(2000, 4500),
        validation,
      });
    }
  }

  const docRows = docSeeds.map((d) => {
    const mapping = pipelineSchemaMap.get(d.pipelineId);
    const jobId = jobBySlug.get(d.job);
    if (!jobId || !mapping) return null;
    const contentHash = crypto
      .createHash("sha256")
      .update(`${d.job}:${d.filename}`)
      .digest("hex");
    return {
      tenantId: TENANT,
      jobId,
      filename: d.filename,
      storageKey: `seed/${d.job}/${d.filename}`,
      fileSize: 150_000,
      mimeType: "application/pdf",
      contentHash,
      pageCount: 1,
      schemaId: mapping.schemaId,
      schemaVersionId: mapping.versionId,
      status: d.status,
      confidence: d.confidence,
      durationMs: d.durationMs ?? null,
      validationJson: d.validation ?? null,
      extractionJson: null,
      startedAt: d.status === "extracting" ? null : new Date(Date.now() - rand(60_000, 3_600_000)),
      completedAt: d.status === "extracting" ? null : new Date(Date.now() - rand(1000, 60_000)),
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  const docsInserted = docRows.length > 0
    ? await db.insert(schema.documents).values(docRows).returning({
        id: schema.documents.id,
        filename: schema.documents.filename,
        status: schema.documents.status,
        schemaId: schema.documents.schemaId,
        validationJson: schema.documents.validationJson,
      })
    : [];
  console.log(`  ${docsInserted.length} documents created`);

  // ── Review items — one per review document + a couple of completed ones ──
  // Every row is driven by a real document + schema. Never hardcoded in the UI;
  // the dashboard queries /api/review which reads this table.
  type ReviewSeed = {
    filename: string;
    fieldName: string;
    reason: string;
    proposedValue: unknown;
    confidence: string;
    validationRule?: string;
    status: "pending" | "completed";
    resolution?: "approved" | "rejected";
    finalValue?: unknown;
    note?: string;
    resolvedMinutesAgo?: number;
  };

  const reviewSeeds: ReviewSeed[] = [
    // Pending — low confidence on a claim amount (worst in queue)
    {
      filename: "claim-0012.pdf",
      fieldName: "claim_amount",
      reason: "low_confidence",
      proposedValue: "12.50",
      confidence: "0.6800",
      status: "pending",
    },
    // Pending — low confidence on policy number
    {
      filename: "claim-0019.pdf",
      fieldName: "policy_number",
      reason: "low_confidence",
      proposedValue: "MRD-8241",
      confidence: "0.7200",
      status: "pending",
    },
    // Pending — low confidence on claimant name (handwritten)
    {
      filename: "claim-0025.pdf",
      fieldName: "claimant_name",
      reason: "low_confidence",
      proposedValue: "H. Brookes",
      confidence: "0.8100",
      status: "pending",
    },
    // Pending — validation failed (subtotal + tax != total)
    {
      filename: "invoice-0087.pdf",
      fieldName: "total_amount",
      reason: "validation_failed",
      proposedValue: "500.00",
      confidence: "0.9100",
      validationRule: "subtotal_plus_tax_equals_total",
      status: "pending",
    },
    // Pending — mandatory review regardless of confidence
    {
      filename: "invoice-0001.pdf",
      fieldName: "vendor",
      reason: "mandatory_field_review",
      proposedValue: "Brighton & Co. Contractors",
      confidence: "0.9700",
      status: "pending",
    },
    // Pending — sampling (high confidence but randomly pulled for QA)
    {
      filename: "invoice-0002.pdf",
      fieldName: "invoice_date",
      reason: "sampling",
      proposedValue: "2026-03-28",
      confidence: "0.9900",
      status: "pending",
    },
    // Completed — approved as-is
    {
      filename: "invoice-0087.pdf",
      fieldName: "subtotal",
      reason: "low_confidence",
      proposedValue: "3950.00",
      confidence: "0.8500",
      status: "completed",
      resolution: "approved",
      finalValue: "3950.00",
      resolvedMinutesAgo: 45,
    },
    // Completed — approved with edits
    {
      filename: "invoice-0003.pdf",
      fieldName: "line_items",
      reason: "low_confidence",
      proposedValue: [{ description: "Services", amount: 1200 }],
      confidence: "0.7600",
      status: "completed",
      resolution: "approved",
      finalValue: [
        { description: "Consulting services — Q1", amount: 1200 },
      ],
      note: "Expanded truncated line item description",
      resolvedMinutesAgo: 120,
    },
  ];

  // Link each review seed to a real document row we just inserted.
  const docByFilename = new Map(docsInserted.map((d) => [d.filename, d]));
  const reviewRows = reviewSeeds
    .map((r) => {
      const doc = docByFilename.get(r.filename);
      if (!doc) return null;
      const resolvedAt =
        r.status === "completed" && r.resolvedMinutesAgo
          ? new Date(Date.now() - r.resolvedMinutesAgo * 60_000)
          : null;
      return {
        tenantId: TENANT,
        documentId: doc.id,
        schemaId: doc.schemaId!,
        fieldName: r.fieldName,
        reason: r.reason,
        proposedValue: r.proposedValue,
        confidence: r.confidence,
        validationRule: r.validationRule ?? null,
        status: r.status,
        resolution: r.resolution ?? null,
        finalValue: r.finalValue ?? null,
        note: r.note ?? null,
        resolvedBy: r.status === "completed" ? USER : null,
        resolvedAt,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (reviewRows.length > 0) {
    await db.insert(schema.reviewItems).values(reviewRows);
  }
  console.log(`  ${reviewRows.length} review items created`);

  console.log("Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
