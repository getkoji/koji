/**
 * Integration test for the `edited` flag on review items (oss-494), against a
 * real Postgres. Mounts the real `review` router with injected auth context.
 *
 * The regression: `POST /review/:id/accept` and `POST /review/:id/override`
 * both write `resolution = "approved"`, so an extraction a human accepted and
 * one a human corrected were indistinguishable in the data. The only way to
 * tell them apart was diffing `final_value` against `proposed_value` in jsonb
 * — brittle for arrays and objects, and impossible to index or aggregate. On
 * production that made the human-correction rate — the single most valuable
 * deployed-value metric — unanswerable across 633 resolved items.
 *
 * `edited` is now recorded at write time by the endpoint that knows the
 * answer. `resolution` deliberately stays "approved" for both: promotion to
 * corpus gates on it (`resolvePromotion`), as do the review badge and any
 * external consumer, so splitting it would have silently stopped corrected
 * items — the most valuable ground truth there is — from being promotable.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, schema, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import type { Env } from "../env";
import { review } from "./review";

let container: StartedPostgreSqlContainer;
let db: Db;

const tenant = randomUUID();
const user = randomUUID();
const project = randomUUID();
let schemaId: string;
let pipelineId: string;
let jobId: string;

function app() {
  const a = new Hono<Env>();
  a.use("*", async (c, next) => {
    c.set("db", db as any);
    c.set("tenantId", tenant);
    c.set("principal", { userId: user, email: "o@x.com", name: "Owner" } as any);
    c.set("roles", ["owner"]);
    c.set("grants", new Set(["review:act", "review:read", "corpus:write"]) as any);
    c.set("accessibleProjectIds", null as any);
    c.set("projectId", project);
    // requireFeature("hitl_review") calls billing.canUse — the plan gate, not
    // a context flag.
    c.set("billing", { canUse: async () => ({ allowed: true }) } as any);
    await next();
  });
  a.route("/api/review", review);
  return a;
}

/** Seed a document + a pending review item on one field. */
async function seedItem(proposed: unknown): Promise<string> {
  const documentId = randomUUID();
  await db.insert(schema.documents).values({
    id: documentId,
    tenantId: tenant,
    jobId,
    filename: "doc.pdf",
    storageKey: `s/${documentId}.pdf`,
    fileSize: 1024,
    mimeType: "application/pdf",
    contentHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    status: "review",
    extractionJson: { total: proposed },
  });
  const id = randomUUID();
  await db.insert(schema.reviewItems).values({
    id,
    tenantId: tenant,
    projectId: project,
    documentId,
    schemaId,
    fieldName: "total",
    reason: "low_confidence",
    proposedValue: proposed as never,
    confidence: "0.1000",
    status: "pending",
  });
  return id;
}

async function itemRow(id: string) {
  const [row] = await db
    .select({
      status: schema.reviewItems.status,
      resolution: schema.reviewItems.resolution,
      edited: schema.reviewItems.edited,
      finalValue: schema.reviewItems.finalValue,
    })
    .from(schema.reviewItems)
    .where(eq(schema.reviewItems.id, id))
    .limit(1);
  return row!;
}

function post(path: string, body: unknown) {
  return app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
    id: tenant, slug: "acme", displayName: "Acme", plan: "scale",
  });
  await db.insert(schema.users).values({
    id: user, email: "o@x.com", authProvider: "local", authProviderId: "o@x.com",
  });
  await db.insert(schema.projects).values({
    id: project, tenantId: tenant, slug: "default", displayName: "Default", createdBy: user,
  });
  schemaId = randomUUID();
  await db.insert(schema.schemas).values({
    id: schemaId, tenantId: tenant, projectId: project,
    slug: "invoice", displayName: "Invoice", createdBy: user,
  });
  pipelineId = randomUUID();
  await db.insert(schema.pipelines).values({
    id: pipelineId, tenantId: tenant, projectId: project, slug: "p",
    displayName: "P", yamlSource: "pipeline: p\nsteps: []\n", createdBy: user,
  });
  jobId = randomUUID();
  await db.insert(schema.jobs).values({
    id: jobId, tenantId: tenant, projectId: project, slug: "job-1",
    pipelineId, triggerType: "manual", status: "running",
  });
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.reviewItems);
});

describe("review item `edited` flag (oss-494)", () => {
  test("accept records edited=false", async () => {
    const id = await seedItem(100);
    const res = await post(`/api/review/${id}/accept`, {});
    expect(res.status).toBe(200);

    const row = await itemRow(id);
    expect(row.status).toBe("completed");
    expect(row.resolution).toBe("approved");
    expect(row.edited).toBe(false);
  });

  test("override records edited=true while staying resolution=approved", async () => {
    const id = await seedItem(100);
    const res = await post(`/api/review/${id}/override`, { value: 250 });
    expect(res.status).toBe(200);

    const row = await itemRow(id);
    expect(row.resolution).toBe("approved");
    expect(row.edited).toBe(true);
    expect(row.finalValue).toBe(250);
  });

  test("reject records edited=false", async () => {
    const id = await seedItem(100);
    const res = await post(`/api/review/${id}/reject`, { reason: "unreadable scan" });
    expect(res.status).toBe(200);

    const row = await itemRow(id);
    expect(row.resolution).toBe("rejected");
    expect(row.edited).toBe(false);
  });

  test("the two are distinguishable without diffing jsonb", async () => {
    // The point of the column. An array value makes the old jsonb comparison
    // especially unreliable, and it is exactly the shape that dominated the
    // production queue.
    const accepted = await seedItem([{ line: "a" }]);
    const corrected = await seedItem([{ line: "a" }]);
    await post(`/api/review/${accepted}/accept`, {});
    await post(`/api/review/${corrected}/override`, { value: [{ line: "a" }, { line: "b" }] });

    const rows = await db
      .select({ edited: schema.reviewItems.edited })
      .from(schema.reviewItems)
      .where(eq(schema.reviewItems.status, "completed"));
    expect(rows.filter((r) => r.edited)).toHaveLength(1);
    expect(rows.filter((r) => !r.edited)).toHaveLength(1);
  });

  test("a corrected item is still promotable as ground truth", async () => {
    // The regression this design avoids: had `/override` written
    // resolution="corrected", `resolvePromotion` would refuse it and the
    // best ground truth we have — a human-corrected value — could never
    // reach the corpus.
    const id = await seedItem(100);
    await post(`/api/review/${id}/override`, { value: 250 });

    const res = await post(`/api/review/${id}/promote`, {});
    // Anything but the "must be resolved and approved" rejection: the gate
    // opened. Downstream corpus wiring is covered by the promotion tests.
    expect(res.status).not.toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").not.toContain("must be resolved and approved");
  });
});
