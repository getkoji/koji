/**
 * Route tests for the classifier corpus surface (oss-450).
 *
 * `resolveClassifierConfig` (the class vocabulary) and `upsertCorpusDocument`
 * (the pool write) are mocked so the test drives the route's own logic: label
 * validation wiring, the document_id attach path, dedup, listing, and the
 * no-released-version guard. The label RULE itself is unit-tested in
 * ./classifiers/corpus-label.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, withRLS: (db: any, _scope: any, fn: (tx: any) => Promise<any>) => fn(db) };
});

vi.mock("../classify", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveClassifierConfig: vi.fn(),
  };
});

vi.mock("../schemas/corpus-pool", () => ({
  upsertCorpusDocument: vi.fn(async () => "doc-new"),
}));

const { classifiers } = await import("./classifiers");
const { resolveClassifierConfig } = await import("../classify");

const TENANT = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-4000-8000-00000000aaaa";
const CLS_ID = "00000000-0000-0000-0000-0000000000c1";

function resolvesTo(classIds: string[] | { error: string }) {
  (resolveClassifierConfig as any).mockResolvedValue(
    Array.isArray(classIds)
      ? { config: { classes: classIds.map((id) => ({ id })) }, version: "v0.0.1" }
      : classIds,
  );
}

/** Chainable/awaitable mock; each `.select()` shifts the next queued result. */
function makeDb(selects: unknown[][], insertReturning: unknown[] = [{ id: "entry-1" }]) {
  const q = [...selects];
  const updates: any[] = [];
  const chain = (): any => {
    const result = q.shift() ?? [];
    const c: any = {
      from: () => c,
      innerJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => Promise.resolve(result),
      then: (r: any, j: any) => Promise.resolve(result).then(r, j),
    };
    return c;
  };
  return {
    db: {
      select: () => chain(),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve(insertReturning) }) }),
      update: () => ({ set: (p: any) => { updates.push(p); return { where: () => ({ returning: () => Promise.resolve([{ id: "entry-1" }]) }) }; } }),
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
    c.set("storage", { put: vi.fn() } as any);
    await next();
  });
  a.route("/api/classifiers", classifiers);
  return a;
}

function postJson(a: Hono<Env>, body: unknown) {
  return a.request("/api/classifiers/docs/corpus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CLS_ROW = [{ id: CLS_ID, projectId: PROJECT }];
const POOL_DOC = [{ id: "doc-1", filename: "a.pdf", storageKey: "k/a", fileSize: 10, mimeType: "application/pdf", contentHash: "a".repeat(64) }];

describe("POST /api/classifiers/:slug/corpus", () => {
  it("labels a pooled document by document_id with a valid class id", async () => {
    resolvesTo(["invoice", "receipt"]);
    // query order: classifier row, pool doc, dedup (none)
    const { db } = makeDb([CLS_ROW, POOL_DOC, []]);
    const res = await postJson(app(db), { document_id: "doc-1", label: "invoice" });
    expect(res.status).toBe(201);
  });

  it("rejects a label that is not a released class id", async () => {
    resolvesTo(["invoice", "receipt"]);
    const { db } = makeDb([CLS_ROW]);
    const res = await postJson(app(db), { document_id: "doc-1", label: "contract" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("contract");
  });

  it("404s when the document is not in the project pool", async () => {
    resolvesTo(["invoice"]);
    const { db } = makeDb([CLS_ROW, []]); // pool doc lookup empty
    const res = await postJson(app(db), { document_id: "missing", label: "invoice" });
    expect(res.status).toBe(404);
  });

  it("returns the existing entry when the document is already labelled (dedup)", async () => {
    resolvesTo(["invoice"]);
    const existing = [{ id: "entry-existing", classifierId: CLS_ID, documentId: "doc-1" }];
    const { db } = makeDb([CLS_ROW, POOL_DOC, existing]);
    const res = await postJson(app(db), { document_id: "doc-1", label: "invoice" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).id).toBe("entry-existing");
  });

  it("409s when the classifier has no released version to validate labels against", async () => {
    resolvesTo({ error: "no_classifier" });
    const { db } = makeDb([CLS_ROW]);
    const res = await postJson(app(db), { document_id: "doc-1", label: "invoice" });
    expect(res.status).toBe(409);
  });

  it("404s for an unknown classifier", async () => {
    resolvesTo(["invoice"]);
    const { db } = makeDb([[]]); // classifier lookup empty
    const res = await postJson(app(db), { document_id: "doc-1", label: "invoice" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/classifiers/:slug/corpus", () => {
  it("lists entries with their label pulled out of ground truth", async () => {
    const entries = [
      { id: "e1", documentId: "d1", filename: "a.pdf", fileSize: 10, mimeType: "application/pdf", source: "upload", groundTruthJson: { label: "invoice" }, createdAt: new Date() },
    ];
    const { db } = makeDb([[{ id: CLS_ID }], entries]);
    const res = await app(db).request("/api/classifiers/docs/corpus");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data[0].label).toBe("invoice");
    expect(body.data[0].groundTruthJson).toBeUndefined();
  });
});
