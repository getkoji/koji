/**
 * Integration test for DAG-pipeline metering against a real Postgres.
 *
 * The regression this guards: `dag-runner.ts` terminated documents on its own
 * code paths and never recorded a billable event, so every document finishing
 * under a DAG/router pipeline was invisible to metering while still incurring
 * full parse + extract cost. Only the simple-pipeline path in `process.ts`
 * billed. On prod this silently zeroed ~42% of one month's billable documents.
 *
 * A mocked DB proves nothing here — the terminal branch depends on real job /
 * document / review-item writes performed by `persistDocumentOutcome`. So the
 * DB is real and only the model-facing seams (parse, endpoint resolution,
 * extraction) are stubbed.
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, schema, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import { NoOpBillingAdapter } from "../billing/noop";
import type { BillableEventInput, BillingAdapter } from "../billing/adapter";

// ── Seams stubbed so no network / model call happens ──────────────────────
const extracted = { invoice_number: "INV-1" };
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
  extractFields: vi.fn(async () => ({
    extracted,
    confidence_scores: confidenceScores,
    provenance: null,
    fit: null,
  })),
}));

vi.mock("./pipeline-schema-version", () => ({
  resolvePipelineSchemaVersion: vi.fn(async () => ({
    parsedJson: { fields: { invoice_number: { type: "string" } } },
    schemaId: schemaIdRef.current,
  })),
}));

const schemaIdRef = { current: "" };

// Imported after the mocks so the module graph picks them up.
const { handleDagRun, initDagRunner, setDagParseProvider } = await import("./dag-runner");
const { initBilling } = await import("./process");

class RecordingBillingAdapter extends NoOpBillingAdapter implements BillingAdapter {
  events: BillableEventInput[] = [];
  async recordBillableEvent(_tenantId: string, event: BillableEventInput): Promise<void> {
    this.events.push(event);
  }
}

let container: StartedPostgreSqlContainer;
let db: Db;
let billing: RecordingBillingAdapter;

const tenantId = randomUUID();
const projectId = randomUUID();
const userId = randomUUID();

const DAG_YAML = `
steps:
  - id: extract_it
    type: extract
    config:
      schema: invoice
`;

/** Seed a job + document and run them through the DAG. Returns the doc id. */
async function runDoc(pipelineId: string): Promise<string> {
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

  await handleDagRun({
    id: randomUUID(),
    tenantId,
    kind: "dag_run",
    payload: { documentId, pipelineId },
  } as never);

  return documentId;
}

async function seedPipeline(reviewThreshold: string, schemaId: string | null): Promise<string> {
  const pipelineId = randomUUID();
  await db.insert(schema.pipelines).values({
    id: pipelineId,
    tenantId,
    projectId,
    slug: `p-${pipelineId.slice(0, 8)}`,
    displayName: "Router",
    schemaId,
    reviewThreshold,
    yamlSource: DAG_YAML,
    createdBy: userId,
  });
  return pipelineId;
}

async function docRow(documentId: string) {
  const [row] = await db
    .select({
      status: schema.documents.status,
      extractionJson: schema.documents.extractionJson,
    })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId))
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

  initDagRunner(db, {} as never);
  // Without a parse provider the runner skips parsing entirely, docText stays
  // undefined, and the extract step no-ops — which would quietly send every
  // case down the non-extract tail path and make these tests vacuous.
  setDagParseProvider({} as never);
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

beforeEach(() => {
  billing = new RecordingBillingAdapter();
  initBilling(billing);
  confidenceScores = { invoice_number: 0.99 };
});

describe("DAG pipeline metering", () => {
  test("bills a document the DAG delivered", async () => {
    const pipelineId = await seedPipeline("0.5", schemaIdRef.current);
    const documentId = await runDoc(pipelineId);

    const row = await docRow(documentId);
    // Guards against a vacuous pass: if extraction had been skipped the doc
    // would still read `delivered`, but via the non-extract tail path.
    expect(row.extractionJson).toEqual(extracted);
    expect(row.status).toBe("delivered");
    expect(billing.events).toHaveLength(1);
    expect(billing.events[0]).toMatchObject({
      kind: "document_processed",
      documentId,
      disposition: "billable",
      terminalState: "delivered",
    });
  });

  test("bills a document the DAG routed to review", async () => {
    confidenceScores = { invoice_number: 0.1 };
    const pipelineId = await seedPipeline("0.9", schemaIdRef.current);
    const documentId = await runDoc(pipelineId);

    const row = await docRow(documentId);
    expect(row.extractionJson).toEqual(extracted);
    expect(row.status).toBe("review");
    expect(billing.events).toHaveLength(1);
    expect(billing.events[0]).toMatchObject({
      documentId,
      disposition: "billable",
      terminalState: "review",
    });
  });

  test("bills exactly one event per document", async () => {
    const pipelineId = await seedPipeline("0.5", schemaIdRef.current);
    await runDoc(pipelineId);
    expect(billing.events).toHaveLength(1);
  });
});
