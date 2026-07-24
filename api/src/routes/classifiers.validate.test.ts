/**
 * Route tests for the classifier validate (backtest) surface (oss-453).
 *
 * The per-document execution (`runClassifyDoc`) and scoring
 * (`maybeFinalizeClassifierRun` → computeClassifierResult) are unit-tested in
 * ./classifiers/validate-run.test.ts and ./classifiers/classify-scoring.test.ts,
 * so here they are mocked: these tests drive the ROUTE's own logic — version
 * resolution + its error shapes, the labelled-corpus gate, sync vs async
 * dispatch, and the poll/read endpoints.
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
  return { ...actual, resolveClassifierConfig: vi.fn() };
});

vi.mock("../classifiers/validate-run", () => ({
  runClassifyDoc: vi.fn(async () => undefined),
  maybeFinalizeClassifierRun: vi.fn(),
}));

const { classifiers } = await import("./classifiers");
const { resolveClassifierConfig } = await import("../classify");
const { runClassifyDoc, maybeFinalizeClassifierRun } = await import("../classifiers/validate-run");

const TENANT = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-4000-8000-00000000aaaa";
const CLS_ID = "00000000-0000-0000-0000-0000000000c1";

function resolvesTo(
  value: { classIds: string[]; version?: string; versionId?: string } | { error: string; requested?: string },
) {
  (resolveClassifierConfig as any).mockResolvedValue(
    "error" in value
      ? value
      : {
          config: { classes: value.classIds.map((id) => ({ id })) },
          version: value.version ?? "v1.0.0",
          versionId: value.versionId ?? "ver-1",
        },
  );
}

/** Chainable/awaitable mock; each `.select()` shifts the next queued result. */
function makeDb(selects: unknown[][], insertReturning: unknown[] = [{ id: "run-1" }]) {
  const q = [...selects];
  const chain = (): any => {
    const result = q.shift() ?? [];
    const c: any = {
      from: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => Promise.resolve(result),
      then: (r: any, j: any) => Promise.resolve(result).then(r, j),
    };
    return c;
  };
  return {
    select: () => chain(),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve(insertReturning) }) }),
  };
}

function app(db: any, queue?: any) {
  const a = new Hono<Env>();
  a.use("*", async (c, next) => {
    c.set("tenantId", TENANT as any);
    c.set("projectId", PROJECT as any);
    c.set("principal", { userId: "u1" } as any);
    c.set("grants", new Set(["job:run"]) as any);
    c.set("roles", ["owner"] as any);
    c.set("db", db);
    c.set("storage", { getBuffer: vi.fn() } as any);
    c.set("parseProvider", undefined as any);
    c.set("queue", queue ?? { enqueue: vi.fn(async () => undefined) });
    await next();
  });
  a.route("/api/classifiers", classifiers);
  return a;
}

function postValidate(a: Hono<Env>, body: unknown = {}) {
  return a.request("/api/classifiers/docs/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

const CLS_ROW = [{ id: CLS_ID, projectId: PROJECT }];
const LABELLED = [
  { id: "e1", groundTruthJson: { label: "invoice" } },
  { id: "e2", groundTruthJson: { label: "receipt" } },
];

describe("POST /api/classifiers/:slug/validate", () => {
  it("404s for an unknown classifier", async () => {
    resolvesTo({ classIds: ["invoice"] });
    const res = await postValidate(app(makeDb([[]])));
    expect(res.status).toBe(404);
  });

  it("404s when a pinned version does not resolve", async () => {
    resolvesTo({ error: "no_version", requested: "v9.9.9" });
    const res = await postValidate(app(makeDb([CLS_ROW])), { version: "v9.9.9" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toContain("v9.9.9");
  });

  it("409s when the classifier has no released version to backtest", async () => {
    resolvesTo({ error: "no_classifier" });
    const res = await postValidate(app(makeDb([CLS_ROW])));
    expect(res.status).toBe(409);
  });

  it("400s when no corpus entry has a ground-truth label", async () => {
    resolvesTo({ classIds: ["invoice"] });
    // classifier row, then corpus entries all unlabeled
    const db = makeDb([CLS_ROW, [{ id: "e1", groundTruthJson: {} }, { id: "e2", groundTruthJson: null }]]);
    const res = await postValidate(app(db));
    expect(res.status).toBe(400);
    expect(runClassifyDoc).not.toHaveBeenCalled();
  });

  it("sync: runs each labelled doc, finalizes, returns the scored result", async () => {
    resolvesTo({ classIds: ["invoice", "receipt"], version: "v1.2.0", versionId: "ver-x" });
    (maybeFinalizeClassifierRun as any).mockResolvedValue({
      finalized: true,
      result: { docsTotal: 2, docsCorrect: 2, accuracy: 100 },
    });
    const db = makeDb([CLS_ROW, LABELLED]);
    const res = await postValidate(app(db)); // default sync
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.runId).toBe("run-1");
    expect(body.version).toBe("v1.2.0");
    expect(body.accuracy).toBe(100);
    expect((runClassifyDoc as any).mock.calls.length).toBe(2);
  });

  it("sync: 409s when the finalize claim was lost to a concurrent caller", async () => {
    resolvesTo({ classIds: ["invoice"] });
    (maybeFinalizeClassifierRun as any).mockResolvedValue({ finalized: false });
    const db = makeDb([CLS_ROW, LABELLED]);
    const res = await postValidate(app(db));
    expect(res.status).toBe(409);
  });

  it("async: enqueues one job per labelled entry and returns 202 with the run id", async () => {
    resolvesTo({ classIds: ["invoice", "receipt"] });
    const enqueue = vi.fn(async () => undefined);
    const db = makeDb([CLS_ROW, LABELLED]);
    const res = await postValidate(app(db, { enqueue }), { async: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.runId).toBe("run-1");
    expect(body.status).toBe("queued");
    expect(body.docsTotal).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      "classifier.validate.doc",
      { classifierRunId: "run-1", corpusEntryId: "e1" },
      expect.objectContaining({ tenantId: TENANT }),
    );
    // Async must not run any doc in-request.
    expect(runClassifyDoc).not.toHaveBeenCalled();
  });
});

describe("GET /api/classifiers/:slug/validate/runs/:runId", () => {
  function getRun(a: Hono<Env>) {
    return a.request("/api/classifiers/docs/validate/runs/run-1", { method: "GET" });
  }

  it("reports progress while running and the result once completed", async () => {
    // running: cls row, run row (running), progress count
    const running = makeDb([
      CLS_ROW,
      [{ id: "run-1", classifierId: CLS_ID, status: "running", docsTotal: 3, errorMessage: null, resultJson: null }],
      [{ count: 1 }],
    ]);
    let res = await getRun(app(running));
    let body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.status).toBe("running");
    expect(body.docsProcessed).toBe(1);
    expect(body.result).toBeNull();

    const done = makeDb([
      CLS_ROW,
      [
        {
          id: "run-1",
          classifierId: CLS_ID,
          status: "completed",
          docsTotal: 3,
          errorMessage: null,
          resultJson: { accuracy: 66.6 },
        },
      ],
      [{ count: 3 }],
    ]);
    res = await getRun(app(done));
    body = (await res.json()) as any;
    expect(body.status).toBe("completed");
    expect(body.docsProcessed).toBe(3);
    expect(body.result).toEqual({ accuracy: 66.6 });
  });

  it("404s when the run belongs to a different classifier", async () => {
    const db = makeDb([
      CLS_ROW,
      [{ id: "run-1", classifierId: "other-cls", status: "completed", docsTotal: 1, errorMessage: null, resultJson: {} }],
    ]);
    const res = await getRun(app(db));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/classifiers/:slug/validate", () => {
  function getLatest(a: Hono<Env>) {
    return a.request("/api/classifiers/docs/validate", { method: "GET" });
  }

  it("returns null when the classifier has never been backtested", async () => {
    const db = makeDb([CLS_ROW, []]); // no completed run
    const res = await getLatest(app(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("returns the latest completed run's result with the version label", async () => {
    const db = makeDb([
      CLS_ROW,
      [{ id: "run-1", resultJson: { accuracy: 88 }, classifierVersionId: "ver-1", completedAt: null }],
      [{ major: 1, minor: 2, patch: 0, prerelease: null }],
    ]);
    const res = await getLatest(app(db));
    const body = (await res.json()) as any;
    expect(body.runId).toBe("run-1");
    expect(body.version).toBe("v1.2.0");
    expect(body.accuracy).toBe(88);
  });
});
