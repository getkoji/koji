/**
 * Integration test for the stuck-validate-run sweeper (oss-497).
 *
 * The unit tests in sweeper.test.ts mock `db.execute`, so they verify the
 * emit/count logic but say nothing about the query itself — and the query is
 * where this could go wrong: it's an `UPDATE … FROM schemas` join with a
 * COALESCE'd age predicate and aliased RETURNING columns. A mocked DB would
 * happily pass while the real statement swept nothing, or swept everything.
 *
 * The regression: `schema_runs` had no reaper of any kind, so a validate run
 * whose fan-out died sat in 'running' forever. Production carried 15 such rows
 * started between 2026-06-30 and 2026-07-23 — up to eight weeks stale.
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, schema, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";

const createdNotifications: Array<{ tenantId: string; notification: any }> = [];

vi.mock("../notifications/emit", () => ({
  createNotification: vi.fn((scope: string | { tenantId: string }, notification: any) => {
    const tenantId = typeof scope === "string" ? scope : scope.tenantId;
    createdNotifications.push({ tenantId, notification });
  }),
}));

vi.mock("../webhooks/emit", () => ({
  emitWebhookEvent: vi.fn(async () => {}),
}));

const { sweepStuckSchemaRuns, sweepStuckJobs, SCHEMA_RUN_MAX_MS } = await import("./sweeper");

let container: StartedPostgreSqlContainer;
let db: Db;

const tenantId = randomUUID();
const projectId = randomUUID();
const userId = randomUUID();
let schemaId: string;
let schemaVersionId: string;
let pipelineId: string;

/** Seed a schema run with an explicit status and age. */
async function seedRun(opts: {
  status: string;
  /** How long ago the run began. */
  ageMs: number;
  /** Put the age on created_at instead of started_at (the 'queued' shape). */
  queuedShape?: boolean;
  accuracy?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const began = new Date(Date.now() - opts.ageMs);
  await db.insert(schema.schemaRuns).values({
    id,
    tenantId,
    schemaId,
    schemaVersionId,
    runType: "validate",
    status: opts.status,
    startedAt: opts.queuedShape ? null : began,
    createdAt: began,
    accuracy: opts.accuracy ?? null,
  });
  return id;
}

async function runRow(id: string) {
  const [row] = await db
    .select({
      status: schema.schemaRuns.status,
      completedAt: schema.schemaRuns.completedAt,
      errorMessage: schema.schemaRuns.errorMessage,
    })
    .from(schema.schemaRuns)
    .where(eq(schema.schemaRuns.id, id))
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

  schemaId = randomUUID();
  await db.insert(schema.schemas).values({
    id: schemaId,
    tenantId,
    projectId,
    slug: "invoice",
    displayName: "Invoice",
    createdBy: userId,
  });

  pipelineId = randomUUID();
  await db.insert(schema.pipelines).values({
    id: pipelineId,
    tenantId,
    projectId,
    slug: "p",
    displayName: "P",
    yamlSource: "pipeline: p\nsteps: []\n",
    createdBy: userId,
  });

  schemaVersionId = randomUUID();
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
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

beforeEach(async () => {
  createdNotifications.length = 0;
  await db.delete(schema.schemaRuns);
  await db.delete(schema.jobs);
});

describe("sweepStuckSchemaRuns (oss-497)", () => {
  test("sweeps a run stuck in 'running' past the cutoff", async () => {
    const id = await seedRun({ status: "running", ageMs: SCHEMA_RUN_MAX_MS + 60_000 });

    const swept = await sweepStuckSchemaRuns(db);

    expect(swept).toBe(1);
    const row = await runRow(id);
    expect(row.status).toBe("failed");
    expect(row.completedAt).not.toBeNull();
    expect(row.errorMessage).toContain("exceeded max running time");
  });

  test("sweeps a 'queued' run that was never picked up", async () => {
    // A queued run has no started_at, so its age has to come from created_at.
    const id = await seedRun({
      status: "queued",
      ageMs: SCHEMA_RUN_MAX_MS + 60_000,
      queuedShape: true,
    });

    expect(await sweepStuckSchemaRuns(db)).toBe(1);
    expect((await runRow(id)).status).toBe("failed");
  });

  test("leaves a run that is still within the cutoff", async () => {
    const id = await seedRun({ status: "running", ageMs: 60_000 });

    expect(await sweepStuckSchemaRuns(db)).toBe(0);
    const row = await runRow(id);
    expect(row.status).toBe("running");
    expect(row.completedAt).toBeNull();
  });

  test("never touches a completed run, however old", async () => {
    // The whole point of the sweep is repairing history, so it must not be
    // able to rewrite a run that legitimately finished months ago.
    const id = await seedRun({
      status: "completed",
      ageMs: 90 * 24 * 60 * 60 * 1000,
      accuracy: "0.9100",
    });

    expect(await sweepStuckSchemaRuns(db)).toBe(0);
    expect((await runRow(id)).status).toBe("completed");
  });

  test("emits one notification per swept run, scoped to its tenant", async () => {
    await seedRun({ status: "running", ageMs: SCHEMA_RUN_MAX_MS + 60_000 });
    await seedRun({ status: "running", ageMs: SCHEMA_RUN_MAX_MS + 120_000 });

    expect(await sweepStuckSchemaRuns(db)).toBe(2);
    expect(createdNotifications).toHaveLength(2);
    for (const n of createdNotifications) {
      expect(n.tenantId).toBe(tenantId);
      expect(n.notification.type).toBe("validate.failed");
      // The schema slug is joined in from `schemas` — proves the UPDATE … FROM
      // actually resolved, rather than returning a null column.
      expect(n.notification.title).toContain("invoice");
    }
  });

  test("preserves an error message the run already carried", async () => {
    const id = randomUUID();
    const began = new Date(Date.now() - (SCHEMA_RUN_MAX_MS + 60_000));
    await db.insert(schema.schemaRuns).values({
      id,
      tenantId,
      schemaId,
      schemaVersionId,
      runType: "validate",
      status: "running",
      startedAt: began,
      createdAt: began,
      errorMessage: "parse provider unreachable",
    });

    expect(await sweepStuckSchemaRuns(db)).toBe(1);
    // COALESCE keeps the real cause rather than overwriting it with the
    // generic sweep reason.
    expect((await runRow(id)).errorMessage).toBe("parse provider unreachable");
  });

  test("is idempotent — a second sweep finds nothing", async () => {
    await seedRun({ status: "running", ageMs: SCHEMA_RUN_MAX_MS + 60_000 });

    expect(await sweepStuckSchemaRuns(db)).toBe(1);
    expect(await sweepStuckSchemaRuns(db)).toBe(0);
  });
});

/**
 * The jobs sweeper (oss-205) shipped with its timestamps bound as raw Date
 * objects, which the postgres driver rejects — so `sweepStuckJobs` threw
 * ERR_INVALID_ARG_TYPE on its very first query and never swept anything. Its
 * unit tests mock `db.execute`, so nothing caught it; production carried jobs
 * stuck in 'running' since July as a result. These run the real statement.
 */
describe("sweepStuckJobs against real Postgres (oss-497)", () => {
  async function seedJob(opts: { ageMs: number; docsProcessed: number }): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.jobs).values({
      id,
      tenantId,
      projectId,
      slug: `job-${id.slice(0, 8)}`,
      pipelineId,
      triggerType: "manual",
      status: "running",
      startedAt: new Date(Date.now() - opts.ageMs),
      docsProcessed: opts.docsProcessed,
      docsTotal: 3,
    });
    return id;
  }

  async function jobStatus(id: string) {
    const [row] = await db
      .select({ status: schema.jobs.status })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, id))
      .limit(1);
    return row!.status;
  }

  test("sweeps a job past the hard max, whatever its progress", async () => {
    const id = await seedJob({ ageMs: 35 * 60_000, docsProcessed: 2 });
    expect(await sweepStuckJobs(db)).toBe(1);
    expect(await jobStatus(id)).toBe("failed");
  });

  test("sweeps a zero-progress job past the no-progress window", async () => {
    const id = await seedJob({ ageMs: 12 * 60_000, docsProcessed: 0 });
    expect(await sweepStuckJobs(db)).toBe(1);
    expect(await jobStatus(id)).toBe("failed");
  });

  test("leaves a job that is making progress inside the window", async () => {
    const id = await seedJob({ ageMs: 12 * 60_000, docsProcessed: 2 });
    expect(await sweepStuckJobs(db)).toBe(0);
    expect(await jobStatus(id)).toBe("running");
  });
});
