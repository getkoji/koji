/**
 * Sweeper unit tests. We mock db.execute so the test doesn't need Postgres
 * — the sweep query body is verified end-to-end in the postgres RLS
 * round-trip test, not here. What this file guards:
 *
 *   - No rows returned → no events emitted, returns 0.
 *   - Hard-max rows produce events with "exceeded max running time" wording.
 *   - Zero-progress rows produce events with "stuck before making progress"
 *     wording.
 *   - One bad webhook doesn't stop the next job's events.
 *   - Notifications are emitted to the row's tenant_id, never a hard-coded
 *     or callsite-controlled value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const emittedWebhooks: Array<{ tenantId: string; projectId: string | null; type: string; data: any }> = [];
const createdNotifications: Array<{ tenantId: string; notification: any }> = [];
let webhookShouldThrow = false;

vi.mock("../webhooks/emit", () => ({
  emitWebhookEvent: vi.fn(async (scope: string | { tenantId: string; projectId?: string | null }, type: string, data: any) => {
    if (webhookShouldThrow) throw new Error("webhook backend down");
    const tenantId = typeof scope === "string" ? scope : scope.tenantId;
    const projectId = typeof scope === "string" ? null : (scope.projectId ?? null);
    emittedWebhooks.push({ tenantId, projectId, type, data });
  }),
}));

vi.mock("../notifications/emit", () => ({
  createNotification: vi.fn((scope: string | { tenantId: string; projectId?: string | null }, notification: any) => {
    const tenantId = typeof scope === "string" ? scope : scope.tenantId;
    createdNotifications.push({ tenantId, notification });
  }),
}));

import { sweepStuckJobs } from "./sweeper";

interface FakeRow {
  id: string;
  tenant_id: string;
  slug: string;
  started_at: Date;
  docs_processed: number;
  docs_total: number;
}

function makeDb(rows: FakeRow[]) {
  return {
    execute: vi.fn(async () => rows),
  } as any;
}

beforeEach(() => {
  emittedWebhooks.length = 0;
  createdNotifications.length = 0;
  webhookShouldThrow = false;
});

const TENANT_A = "00000000-0000-0000-0000-00000000000a";
const TENANT_B = "00000000-0000-0000-0000-00000000000b";

describe("sweepStuckJobs", () => {
  it("returns 0 and emits nothing when no rows match", async () => {
    const db = makeDb([]);
    const swept = await sweepStuckJobs(db);
    expect(swept).toBe(0);
    expect(emittedWebhooks).toHaveLength(0);
    expect(createdNotifications).toHaveLength(0);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("emits webhook + notification per swept row", async () => {
    const now = new Date("2026-06-18T12:00:00Z");
    const longRunningStart = new Date(now.getTime() - 35 * 60_000); // 35m
    const stalledStart = new Date(now.getTime() - 12 * 60_000); // 12m
    const db = makeDb([
      {
        id: "job-a1",
        tenant_id: TENANT_A,
        slug: "pipeline-a",
        started_at: longRunningStart,
        docs_processed: 42,
        docs_total: 100,
      },
      {
        id: "job-b1",
        tenant_id: TENANT_B,
        slug: "pipeline-b",
        started_at: stalledStart,
        docs_processed: 0,
        docs_total: 5,
      },
    ]);

    const swept = await sweepStuckJobs(db, now);
    expect(swept).toBe(2);
    expect(emittedWebhooks).toHaveLength(2);
    expect(createdNotifications).toHaveLength(2);

    // Tenant A — hard-max wording, includes partial progress
    const aWebhook = emittedWebhooks.find((w) => w.tenantId === TENANT_A)!;
    expect(aWebhook.type).toBe("job.failed");
    expect(aWebhook.data.job_id).toBe("job-a1");
    expect(aWebhook.data.docs_processed).toBe(42);
    expect(aWebhook.data.reason).toContain("exceeded max running time");
    const aNotif = createdNotifications.find((n) => n.tenantId === TENANT_A)!;
    expect(aNotif.notification.type).toBe("job.failed");
    expect(aNotif.notification.body).toContain("exceeded max running time");

    // Tenant B — no-progress wording, mentions 0 docs
    const bWebhook = emittedWebhooks.find((w) => w.tenantId === TENANT_B)!;
    expect(bWebhook.data.reason).toContain("stuck before making progress");
    expect(bWebhook.data.docs_processed).toBe(0);
    const bNotif = createdNotifications.find((n) => n.tenantId === TENANT_B)!;
    expect(bNotif.notification.body).toContain("stuck before making progress");
  });

  it("each row's events use its own tenant_id, never cross-leaked", async () => {
    const now = new Date("2026-06-18T12:00:00Z");
    const start = new Date(now.getTime() - 35 * 60_000);
    const db = makeDb([
      { id: "ja", tenant_id: TENANT_A, slug: "a", started_at: start, docs_processed: 1, docs_total: 1 },
      { id: "jb", tenant_id: TENANT_B, slug: "b", started_at: start, docs_processed: 1, docs_total: 1 },
    ]);

    await sweepStuckJobs(db, now);

    // Tenant A's webhook + notification reference job ja, tenant B's reference jb.
    const aHooks = emittedWebhooks.filter((w) => w.tenantId === TENANT_A);
    const bHooks = emittedWebhooks.filter((w) => w.tenantId === TENANT_B);
    expect(aHooks).toHaveLength(1);
    expect(bHooks).toHaveLength(1);
    expect(aHooks[0]!.data.job_id).toBe("ja");
    expect(bHooks[0]!.data.job_id).toBe("jb");

    const aNotifs = createdNotifications.filter((n) => n.tenantId === TENANT_A);
    const bNotifs = createdNotifications.filter((n) => n.tenantId === TENANT_B);
    expect(aNotifs).toHaveLength(1);
    expect(bNotifs).toHaveLength(1);
    expect(aNotifs[0]!.notification.data.jobId).toBe("ja");
    expect(bNotifs[0]!.notification.data.jobId).toBe("jb");
  });

  it("a webhook failure does not stop the notification for that job or events for later jobs", async () => {
    webhookShouldThrow = true;
    const now = new Date("2026-06-18T12:00:00Z");
    const start = new Date(now.getTime() - 35 * 60_000);
    const db = makeDb([
      { id: "j1", tenant_id: TENANT_A, slug: "p1", started_at: start, docs_processed: 1, docs_total: 1 },
      { id: "j2", tenant_id: TENANT_A, slug: "p2", started_at: start, docs_processed: 1, docs_total: 1 },
    ]);

    const swept = await sweepStuckJobs(db, now);

    // Webhook side recorded zero (every emit threw). Notifications still went out.
    expect(swept).toBe(2);
    expect(emittedWebhooks).toHaveLength(0);
    expect(createdNotifications).toHaveLength(2);
  });

  it("respects custom thresholds", async () => {
    const db = makeDb([]);
    await sweepStuckJobs(db, new Date(), { hardMaxMs: 5 * 60_000, noProgressMs: 2 * 60_000 });
    // No assertions on the SQL itself here — just that custom thresholds
    // don't blow up the codepath. The SQL is exercised at integration level.
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
