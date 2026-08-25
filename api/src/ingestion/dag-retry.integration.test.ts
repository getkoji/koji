/**
 * Integration test for DAG-pipeline retry idempotency against a real Postgres.
 *
 * The regression this guards (oss-493): `pipeline_step_runs` is UNIQUE on
 * (document_id, step_id), and `dag-runner.ts` persisted each step with a plain
 * INSERT. A queue retry re-walks the DAG from the entry step, so the first step
 * the previous attempt already recorded threw a unique violation — every retry
 * failed for the same reason, regardless of whether the original error was
 * transient. The attempt counter burned down to max_retries and the document
 * was stranded in `processing` forever.
 *
 * On prod this wedged 109 of 18,120 documents in one project, the oldest for
 * six weeks. All 109 background_jobs rows carried the same error:
 * `Failed query: insert into "pipeline_step_runs" ...`, and the sampled params
 * showed the step had actually *succeeded* on the retry (status=completed)
 * before dying on the write.
 *
 * A mocked DB proves nothing here — the whole bug is a database constraint, so
 * the DB is real and only the model-facing seams are stubbed.
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, schema, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import { NoOpBillingAdapter } from "../billing/noop";

// ── Seams stubbed so no network / model call happens ──────────────────────
const extracted = { invoice_number: "INV-1" };
/** Flipped per-test so one attempt can fail and the next succeed. */
let extractShouldThrow = false;

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
    return { extracted, confidence_scores: { invoice_number: 0.99 }, provenance: null, fit: null };
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

/** Two steps so the retry re-walks more than one already-recorded row. */
const DAG_YAML = `
pipeline: retry-fixture
steps:
  - id: classify_line
    type: classify
    on:
      _default: extract_it
  - id: extract_it
    type: extract
    config:
      schema: invoice
`;

async function seedPipeline(): Promise<string> {
  const pipelineId = randomUUID();
  await db.insert(schema.pipelines).values({
    id: pipelineId,
    tenantId,
    projectId,
    slug: `p-${pipelineId.slice(0, 8)}`,
    displayName: "Router",
    schemaId: schemaIdRef.current,
    reviewThreshold: "0.5",
    yamlSource: DAG_YAML,
    createdBy: userId,
  });
  return pipelineId;
}

/** Seed a job + document without running it. */
async function seedDoc(pipelineId: string): Promise<string> {
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
  });
  await db.insert(schema.documents).values({
    id: documentId,
    tenantId,
    jobId,
    filename: "invoice.pdf",
    storageKey: "s/invoice.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
    contentHash: "a".repeat(64),
    status: "pending",
  });
  return documentId;
}

function run(documentId: string, pipelineId: string) {
  return handleDagRun({
    id: randomUUID(),
    tenantId,
    kind: "dag_run",
    payload: { documentId, pipelineId },
  } as never);
}

async function stepRows(documentId: string) {
  return db
    .select({
      stepId: schema.pipelineStepRuns.stepId,
      status: schema.pipelineStepRuns.status,
      errorMessage: schema.pipelineStepRuns.errorMessage,
    })
    .from(schema.pipelineStepRuns)
    .where(eq(schema.pipelineStepRuns.documentId, documentId));
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
    id: tenantId,
    slug: "acme",
    displayName: "Acme",
    plan: "scale",
  });
  await db.insert(schema.users).values({
    id: userId,
    email: "seed@koji.test",
    authProvider: "local",
    authProviderId: "seed@koji.test",
  });
  await db.insert(schema.projects).values({
    id: projectId,
    tenantId,
    slug: "default",
    displayName: "Default",
    createdBy: userId,
  });

  const schemaId = randomUUID();
  await db.insert(schema.schemas).values({
    id: schemaId,
    tenantId,
    projectId,
    slug: "invoice",
    displayName: "Invoice",
    createdBy: userId,
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

  initDagRunner(db, {} as never);
  setDagParseProvider({} as never);
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

beforeEach(() => {
  initBilling(new NoOpBillingAdapter());
  extractShouldThrow = false;
});

describe("DAG retry idempotency (oss-493)", () => {
  test("re-running the same document does not throw a unique violation", async () => {
    const pipelineId = await seedPipeline();
    const documentId = await seedDoc(pipelineId);

    await run(documentId, pipelineId);
    // The retry is the whole point: before the fix this rejected with
    // `duplicate key value violates unique constraint
    // "pipeline_step_runs_doc_step_idx"`.
    await expect(run(documentId, pipelineId)).resolves.not.toThrow();
  });

  test("a retry leaves exactly one step row per step, not duplicates", async () => {
    const pipelineId = await seedPipeline();
    const documentId = await seedDoc(pipelineId);

    await run(documentId, pipelineId);
    const afterFirst = await stepRows(documentId);
    await run(documentId, pipelineId);
    const afterSecond = await stepRows(documentId);

    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterSecond).toHaveLength(afterFirst.length);
    // One row per distinct step id — the upsert overwrote rather than appended.
    expect(new Set(afterSecond.map((r) => r.stepId)).size).toBe(afterSecond.length);
  });

  test("a transient failure is actually recoverable on retry", async () => {
    const pipelineId = await seedPipeline();
    const documentId = await seedDoc(pipelineId);

    // Attempt 1 fails inside extract — the runner records the failed step and
    // fails the document.
    extractShouldThrow = true;
    await run(documentId, pipelineId);

    const [failedDoc] = await db
      .select({ status: schema.documents.status })
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId))
      .limit(1);
    expect(failedDoc!.status).toBe("failed");

    // Attempt 2 succeeds. This is the behaviour the bug destroyed: the retry
    // used to die on the step-run write before it could recover the document.
    extractShouldThrow = false;
    await run(documentId, pipelineId);

    const [recovered] = await db
      .select({
        status: schema.documents.status,
        extractionJson: schema.documents.extractionJson,
      })
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId))
      .limit(1);
    expect(recovered!.status).toBe("delivered");
    expect(recovered!.extractionJson).toEqual(extracted);

    // The failed step row was overwritten by the successful retry, not left
    // behind alongside it.
    const [extractStep] = await db
      .select({
        status: schema.pipelineStepRuns.status,
        errorMessage: schema.pipelineStepRuns.errorMessage,
      })
      .from(schema.pipelineStepRuns)
      .where(
        and(
          eq(schema.pipelineStepRuns.documentId, documentId),
          eq(schema.pipelineStepRuns.stepId, "extract_it"),
        ),
      );
    expect(extractStep!.status).toBe("completed");
    expect(extractStep!.errorMessage).toBeNull();
  });
});
