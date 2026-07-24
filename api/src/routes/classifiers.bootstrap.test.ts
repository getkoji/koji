/**
 * Route tests for agent-assisted bootstrap labeling (oss-456).
 *
 * `classifyWithConfig` and `resolveClassifierConfig` are mocked so the tests
 * drive the route's own logic: running only over UNLABELED pool documents,
 * writing an EMPTY denormalized ground truth plus a DRAFT proposal row
 * (authored_via_agent), and the approve path that promotes a draft (optionally
 * correcting the label) into the scored ground truth.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, withRLS: (db: any, _scope: any, fn: (tx: any) => Promise<any>) => fn(db) };
});

vi.mock("../classify", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveClassifierConfig: vi.fn(), classifyWithConfig: vi.fn() };
});

const { classifiers } = await import("./classifiers");
const { resolveClassifierConfig, classifyWithConfig } = await import("../classify");

const TENANT = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-4000-8000-00000000aaaa";
const CLS_ID = "00000000-0000-0000-0000-0000000000c1";

function resolvesConfig(classIds: string[]) {
  (resolveClassifierConfig as any).mockResolvedValue({
    config: { classes: classIds.map((id) => ({ id })), maxTier: 3 },
    version: "v1.0.0",
    versionId: "ver-1",
  });
}

/** Chainable mock; each select() shifts the next queued result. Inserts return
 *  a fresh incrementing id so entry + gt rows get distinct ids. */
function makeDb(selects: unknown[][]) {
  const q = [...selects];
  let insertCounter = 0;
  const inserts: any[] = [];
  const updates: any[] = [];
  const chain = (): any => {
    const result = q.shift() ?? [];
    const c: any = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => Promise.resolve(result),
      then: (r: any, j: any) => Promise.resolve(result).then(r, j),
    };
    return c;
  };
  return {
    inserts,
    db: {
      select: () => chain(),
      insert: () => ({
        values: (v: any) => {
          inserts.push(v);
          return { returning: () => Promise.resolve([{ id: `new-${++insertCounter}` }]) };
        },
      }),
      update: () => ({
        set: (p: any) => {
          updates.push(p);
          return { where: () => ({ returning: () => Promise.resolve([{ id: "gt-1", ...p }]) }) };
        },
      }),
    },
    updates,
  };
}

function app(db: any) {
  const a = new Hono<Env>();
  a.use("*", async (c, next) => {
    c.set("tenantId", TENANT as any);
    c.set("projectId", PROJECT as any);
    c.set("principal", { userId: "u1" } as any);
    c.set("grants", new Set(["corpus:read", "corpus:write"]) as any);
    c.set("roles", ["owner"] as any);
    c.set("db", db);
    c.set("storage", { getBuffer: vi.fn(async () => ({ data: Buffer.from("pdf"), contentType: "application/pdf" })) } as any);
    c.set("parseProvider", undefined as any);
    await next();
  });
  a.route("/api/classifiers", classifiers);
  return a;
}

function postBootstrap(db: any, body: unknown = {}) {
  return app(db).request("/api/classifiers/docs/corpus/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CLS_ROW = [{ id: CLS_ID }];

beforeEach(() => vi.clearAllMocks());

describe("POST /:slug/corpus/bootstrap", () => {
  it("proposes a draft label for each unlabeled pool document", async () => {
    resolvesConfig(["invoice", "receipt"]);
    (classifyWithConfig as any).mockResolvedValue({
      label: "invoice",
      confidence: 0.9,
      method: "vision",
      tierUsed: 4,
      evidencePage: 1,
    });
    // classifier row, then the unlabeled-docs query
    const docs = [{ id: "doc-1", filename: "a.pdf", storageKey: "k/a", mimeType: "application/pdf" }];
    const { db, inserts } = makeDb([CLS_ROW, docs]);
    const res = await postBootstrap(db, { limit: 10 });
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b.proposed).toBe(1);
    expect(b.proposals[0].proposedLabel).toBe("invoice");
    expect(b.proposals[0].tierUsed).toBe(4);
    // Ran the classifier at max_tier 4 (VISION) regardless of the config's own ceiling.
    expect((classifyWithConfig as any).mock.calls[0][3].maxTier).toBe(4);
    // CRITICAL: the entry's denormalized ground truth is EMPTY — a draft is
    // never scored by a backtest. The label lives only on the draft GT row.
    const entryInsert = inserts.find((v) => v.classifierId === CLS_ID);
    expect(entryInsert.groundTruthJson).toEqual({});
    const gtInsert = inserts.find((v) => v.authoredViaAgent === true);
    expect(gtInsert.reviewStatus).toBe("draft");
    expect(gtInsert.payloadJson).toEqual({ label: "invoice" });
  });

  it("returns an empty result when there are no unlabeled documents", async () => {
    resolvesConfig(["invoice"]);
    const { db } = makeDb([CLS_ROW, []]);
    const res = await postBootstrap(db);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).proposed).toBe(0);
    expect(classifyWithConfig).not.toHaveBeenCalled();
  });

  it("409s when the classifier has no released version to bootstrap from", async () => {
    (resolveClassifierConfig as any).mockResolvedValue({ error: "no_classifier" });
    const { db } = makeDb([CLS_ROW]);
    const res = await postBootstrap(db);
    expect(res.status).toBe(409);
  });

  it("404s for an unknown classifier", async () => {
    resolvesConfig(["invoice"]);
    const { db } = makeDb([[]]);
    const res = await postBootstrap(db);
    expect(res.status).toBe(404);
  });

  it("skips a document whose classify fails, without killing the run", async () => {
    resolvesConfig(["invoice"]);
    (classifyWithConfig as any).mockRejectedValue(new Error("provider out"));
    const docs = [{ id: "doc-1", filename: "a.pdf", storageKey: "k/a", mimeType: "application/pdf" }];
    const { db } = makeDb([CLS_ROW, docs]);
    const res = await postBootstrap(db);
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b.proposed).toBe(0);
    expect(b.skipped).toBe(1);
  });
});

describe("POST /:slug/corpus/:entryId/ground-truth/:gtId/approve", () => {
  function postApprove(db: any, body: unknown = {}) {
    return app(db).request("/api/classifiers/docs/corpus/e1/ground-truth/gt1/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("approves a draft and promotes its label into the scored ground truth", async () => {
    resolvesConfig(["invoice", "receipt"]);
    // loadClassifierForCorpus: classifier row (id+projectId); then the GT lookup.
    const clsRow = [{ id: CLS_ID, projectId: PROJECT }];
    const gtRow = [{ id: "gt1", payloadJson: { label: "invoice" }, classifierId: CLS_ID }];
    const { db, updates } = makeDb([clsRow, gtRow]);
    const res = await postApprove(db);
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b.label).toBe("invoice");
    // The GT row was marked approved, and the entry's groundTruthJson was set.
    expect(updates.some((u) => u.reviewStatus === "approved")).toBe(true);
    expect(updates.some((u) => JSON.stringify(u.groundTruthJson) === JSON.stringify({ label: "invoice" }))).toBe(true);
  });

  it("corrects the label when one is supplied (validated against class ids)", async () => {
    resolvesConfig(["invoice", "receipt"]);
    const clsRow = [{ id: CLS_ID, projectId: PROJECT }];
    const gtRow = [{ id: "gt1", payloadJson: { label: "invoice" }, classifierId: CLS_ID }];
    const { db, updates } = makeDb([clsRow, gtRow]);
    const res = await postApprove(db, { label: "receipt" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).label).toBe("receipt");
    expect(updates.some((u) => JSON.stringify(u.groundTruthJson) === JSON.stringify({ label: "receipt" }))).toBe(true);
  });

  it("rejects a correction that is not a released class id", async () => {
    resolvesConfig(["invoice"]);
    const clsRow = [{ id: CLS_ID, projectId: PROJECT }];
    const gtRow = [{ id: "gt1", payloadJson: { label: "invoice" }, classifierId: CLS_ID }];
    const { db } = makeDb([clsRow, gtRow]);
    const res = await postApprove(db, { label: "contract" });
    expect(res.status).toBe(400);
  });

  it("404s when the draft belongs to a different classifier", async () => {
    resolvesConfig(["invoice"]);
    const clsRow = [{ id: CLS_ID, projectId: PROJECT }];
    const gtRow = [{ id: "gt1", payloadJson: { label: "invoice" }, classifierId: "other" }];
    const { db } = makeDb([clsRow, gtRow]);
    const res = await postApprove(db);
    expect(res.status).toBe(404);
  });
});
