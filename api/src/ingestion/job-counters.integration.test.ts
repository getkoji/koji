/**
 * Integration test for job document counters (oss-495), against a real
 * Postgres.
 *
 * The regression: `docs_processed / docs_passed / docs_failed / docs_reviewing`
 * were incremented with `+ 1` at every terminal transition and never adjusted
 * when a document was reprocessed or retried. A document that failed on bad
 * input and later succeeded stayed counted as failed forever; a document
 * reprocessed N times bumped `docs_processed` N times.
 *
 * On production that left `docs_processed` (17,246) larger than `docs_total`
 * (15,826) — the counter claimed more documents than existed — and
 * `docs_failed` at 194 against 108 documents whose latest attempt had actually
 * failed, overstating the failure rate by 1.80x. `GET /api/pipelines` serves
 * these numbers to the CLI and dashboard, so every failure rate a user read
 * was wrong in the same direction.
 *
 * Counters are a distribution over documents, not a tally of events: each
 * document contributes to exactly one bucket, the one matching the terminal
 * state it holds now. Only a real database can prove that, since the whole
 * behaviour is SQL increments and decrements.
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, schema, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import { NoOpBillingAdapter } from "../billing/noop";

const extracted = { invoice_number: "INV-1" };
let extractShouldThrow = false;
let confidenceScores: Record<string, number> = { invoice_number: 0.99 };

vi.mock("./seam", () => ({
  resolveParse: vi.fn(async () => ({ provider: {}, fingerprint: "fp-test" })),
  parseDocument: vi.fn(async () => ({
    markdown: "some parsed document text",
    pages: 1,
    ocr_skipped: false,
    engine: "test",
    cached: false,
    textMap: undefined,
    chunks: undefined,
  })),
}));

vi.mock("../extract/resolve-endpoint", () => ({
  resolveExtractEndpoint: vi.fn(async () => ({ model: "test/model", apiKey: "k" })),
  resolveTenantProvider: vi.fn(),
}));

vi.mock("../extract/providers", () => ({
  createProvider: vi.fn(() => ({ generate: vi.fn(async () => "{}") })),
}));

vi.mock("../extract/pipeline", () => ({
  extractFields: vi.fn(async () => {
    if (extractShouldThrow) throw new Error("simulated transient extract failure");
    return { extracted, confidence_scores: confidenceScores, provenance: null, fit: null };
  }),
}));

vi.mock("./pipeline-schema-version", () => ({
  resolvePipelineSchemaVersion: vi.fn(async () => ({
    parsedJson: { fields: { invoice_number: { type: "string" } } },
    schemaId: schemaIdRef.current,
    versionId: schemaVersionIdRef.current,
  })),
}));

const schemaIdRef = { current: "" };
const schemaVersionIdRef = { current: "" };

const { handleDagRun, initDagRunner, setDagParseProvider } = await import("./dag-runner");
const { initBilling } = await import("./process");

let container: StartedPostgreSqlContainer;
let db: Db;

const tenantId = randomUUID();
const projectId = randomUUID();
const userId = randomUUID();
let pipelineId: string;

const DAG_YAML = `
pipeline: counters-fixture
steps:
  - id: extract_it
    type: extract
    config:
      schema: invoice
`;

async function seedDoc(): Promise<{ documentId: string; jobId: string }> {
  const jobId = randomUUID();
  const documentId = randomUUID();
  await db.insert(schema.jobs).values({
    id: jobId,
    tenantId,
    projectId,
    slug: `job-${jobId.slice(0, 8)}`,
    pipelineId,
    triggerType: "manual",
    status: "running",
    docsTotal: 1,
  });
  await db.insert(schema.documents).values({
    id: documentId,
    tenantId,
    jobId,
    filename: "invoice.pdf",
    storageKey: "s/invoice.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
    contentHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    status: "pending",
  });
  return { documentId, jobId };
}

function run(documentId: string) {
  return handleDagRun({
    id: randomUUID(),
    tenantId,
    kind: "dag_run",
    payload: { documentId, pipelineId },
  } as never);
}

async function counters(jobId: string) {
  const [row] = await db
    .select({
      docsTotal: schema.jobs.docsTotal,
      docsProcessed: schema.jobs.docsProcessed,
      docsPassed: schema.jobs.docsPassed,
      docsFailed: schema.jobs.docsFailed,
      docsReviewing: schema.jobs.docsReviewing,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);
  return row!;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("koji_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();
  await runMigrations(container.getConnectionUri());
  db = createDb(container.getConnectionUri(), { max: 4 });

  await db.insert(schema.tenants).values({
    id: tenantId, slug: "acme", displayName: "Acme", plan: "scale",
  });
  await db.insert(schema.users).values({
    id: userId, email: "seed@koji.test", authProvider: "local", authProviderId: "seed@koji.test",
  });
  await db.insert(schema.projects).values({
    id: projectId, tenantId, slug: "default", displayName: "Default", createdBy: userId,
  });

  const schemaId = randomUUID();
  await db.insert(schema.schemas).values({
    id: schemaId, tenantId, projectId, slug: "invoice", displayName: "Invoice", createdBy: userId,
  });
  schemaIdRef.current = schemaId;

  const schemaVersionId = randomUUID();
  await db.insert(schema.schemaVersions).values({
    id: schemaVersionId,
    tenantId,
    schemaId,
    versionNumber: 1,
    yamlSource: "fields:\n  invoice_number:\n    type: string\n",
    yamlHash: "0".repeat(64),
    parsedJson: { fields: { invoice_number: { type: "string" } } },
    committedBy: userId,
  });
  schemaVersionIdRef.current = schemaVersionId;

  pipelineId = randomUUID();
  await db.insert(schema.pipelines).values({
    id: pipelineId,
    tenantId,
    projectId,
    slug: "p",
    displayName: "P",
    schemaId,
    reviewThreshold: "0.5",
    yamlSource: DAG_YAML,
    createdBy: userId,
  });

  initDagRunner(db, {} as never);
  setDagParseProvider({} as never);
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

beforeEach(() => {
  initBilling(new NoOpBillingAdapter());
  extractShouldThrow = false;
  confidenceScores = { invoice_number: 0.99 };
});

describe("job document counters (oss-495)", () => {
  test("a delivered document counts once", async () => {
    const { documentId, jobId } = await seedDoc();
    await run(documentId);

    expect(await counters(jobId)).toMatchObject({
      docsTotal: 1, docsProcessed: 1, docsPassed: 1, docsFailed: 0, docsReviewing: 0,
    });
  });

  test("reprocessing does not count the same document twice", async () => {
    // The headline defect: docs_processed climbed past docs_total because
    // every rerun incremented it again.
    const { documentId, jobId } = await seedDoc();
    await run(documentId);
    await run(documentId);
    await run(documentId);

    const c = await counters(jobId);
    expect(c.docsProcessed).toBe(1);
    expect(c.docsPassed).toBe(1);
    expect(c.docsProcessed).toBeLessThanOrEqual(c.docsTotal);
  });

  test("a document that fails then succeeds is no longer counted as failed", async () => {
    // "Failure-ever" vs "failure-now". This is the exact shape that made the
    // production failure rate unpublishable.
    const { documentId, jobId } = await seedDoc();

    extractShouldThrow = true;
    await run(documentId);
    expect(await counters(jobId)).toMatchObject({ docsProcessed: 1, docsFailed: 1, docsPassed: 0 });

    extractShouldThrow = false;
    await run(documentId);

    expect(await counters(jobId)).toMatchObject({
      docsProcessed: 1, docsFailed: 0, docsPassed: 1, docsReviewing: 0,
    });
  });

  test("a document moving from delivered to review moves buckets, not totals", async () => {
    const { documentId, jobId } = await seedDoc();
    await run(documentId);
    expect(await counters(jobId)).toMatchObject({ docsPassed: 1, docsReviewing: 0 });

    // Re-run with low confidence so the same document routes to review.
    confidenceScores = { invoice_number: 0.1 };
    await run(documentId);

    expect(await counters(jobId)).toMatchObject({
      docsProcessed: 1, docsPassed: 0, docsReviewing: 1, docsFailed: 0,
    });
  });

  test("buckets always sum to docs_processed", async () => {
    // The invariant worth pinning: whatever the sequence, the outcome buckets
    // partition the processed documents exactly.
    const a = await seedDoc();
    await run(a.documentId);
    extractShouldThrow = true;
    await run(a.documentId);
    extractShouldThrow = false;
    confidenceScores = { invoice_number: 0.1 };
    await run(a.documentId);

    const c = await counters(a.jobId);
    expect(c.docsPassed + c.docsFailed + c.docsReviewing).toBe(c.docsProcessed);
    expect(c.docsProcessed).toBe(1);
  });
});
