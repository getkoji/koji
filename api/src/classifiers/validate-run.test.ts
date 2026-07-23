/**
 * Unit tests for the classifier validate-run execution units (oss-451).
 *
 * `withRLS` and `classifyWithConfig` are mocked so the tests drive the control
 * flow — a prediction is recorded on success, a failure is recorded (not
 * thrown), and the finalizer claims atomically and scores. The DB is a queued
 * fake; `writes` records every insert/update so "what was persisted" is
 * directly assertable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, withRLS: (db: any, _scope: any, fn: (tx: any) => Promise<any>) => fn(db) };
});

const classifyMock = vi.fn();
vi.mock("../classify", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, classifyWithConfig: classifyMock };
});

const { runClassifyDoc, maybeFinalizeClassifierRun } = await import("./validate-run");

const CTX = {
  tenantId: "t1",
  projectId: "p1",
  classifierRunId: "run-1",
  config: { maxTier: 3, classes: [{ id: "invoice" }] } as any,
};

/** Fake db. `selects` queues select results; `inserts`/`updates` capture writes. */
function makeDb(selects: unknown[][]) {
  const q = [...selects];
  const inserts: any[] = [];
  const updates: any[] = [];
  const chain = (): any => {
    const result = q.shift() ?? [];
    const c: any = {
      from: () => c, where: () => c, orderBy: () => c,
      limit: () => Promise.resolve(result),
      then: (r: any, j: any) => Promise.resolve(result).then(r, j),
    };
    return c;
  };
  const db: any = {
    select: () => chain(),
    insert: () => ({
      values: (v: any) => {
        inserts.push(v);
        return { onConflictDoUpdate: () => Promise.resolve(), returning: () => Promise.resolve([{ id: "x" }]) };
      },
    }),
    update: () => ({
      set: (v: any) => {
        updates.push(v);
        return { where: () => ({ returning: () => Promise.resolve([{ id: "run-1" }]) }) };
      },
    }),
  };
  return { db, inserts, updates };
}

const storage = { getBuffer: vi.fn(async () => ({ data: Buffer.from("pdf") })) } as any;

const ENTRY = [{
  id: "e1", filename: "a.pdf", storageKey: "k/a", mimeType: "application/pdf",
  groundTruthJson: { label: "invoice" },
}];

beforeEach(() => {
  classifyMock.mockReset();
  storage.getBuffer.mockClear();
});

describe("runClassifyDoc", () => {
  it("records the prediction on a successful classify", async () => {
    classifyMock.mockResolvedValue({ label: "invoice", confidence: 0.9, method: "keyword", tierUsed: 2, evidencePage: 1 });
    const { db, inserts } = makeDb([ENTRY]);
    await runClassifyDoc(db, storage, undefined, CTX, "e1");

    expect(inserts.length).toBe(1);
    expect(inserts[0]).toMatchObject({
      status: "ok",
      expectedLabel: "invoice",
      predictedLabel: "invoice",
      method: "keyword",
      tierUsed: 2,
    });
  });

  it("records a FAILED row (does not throw) when the cascade errors", async () => {
    classifyMock.mockRejectedValue(new Error("provider out"));
    const { db, inserts } = makeDb([ENTRY]);
    await expect(runClassifyDoc(db, storage, undefined, CTX, "e1")).resolves.toBeUndefined();
    expect(inserts[0]).toMatchObject({ status: "failed", expectedLabel: "invoice", predictedLabel: null });
    expect(inserts[0].errorMessage).toContain("provider out");
  });

  it("records a wrong prediction faithfully (scoring happens at finalize)", async () => {
    classifyMock.mockResolvedValue({ label: "receipt", confidence: 0.7, method: "llm", tierUsed: 3, evidencePage: null });
    const { db, inserts } = makeDb([ENTRY]);
    await runClassifyDoc(db, storage, undefined, CTX, "e1");
    expect(inserts[0]).toMatchObject({ status: "ok", expectedLabel: "invoice", predictedLabel: "receipt" });
  });

  it("fails the doc when its file is gone from storage", async () => {
    storage.getBuffer.mockResolvedValueOnce(null);
    const { db, inserts } = makeDb([ENTRY]);
    await runClassifyDoc(db, storage, undefined, CTX, "e1");
    expect(inserts[0].status).toBe("failed");
    expect(classifyMock).not.toHaveBeenCalled();
  });
});

describe("maybeFinalizeClassifierRun", () => {
  const RUN = [{ status: "running", docsTotal: 2, startedAt: null, createdAt: new Date() }];
  const DOCS = [
    { corpusEntryId: "e1", status: "ok", expectedLabel: "invoice", predictedLabel: "invoice", tierUsed: 2, errorMessage: null },
    { corpusEntryId: "e2", status: "ok", expectedLabel: "receipt", predictedLabel: "invoice", tierUsed: 2, errorMessage: null },
  ];

  it("no-ops until every doc has a row", async () => {
    const partial = [{ ...DOCS[0] }]; // only 1 of 2
    const { db } = makeDb([RUN, partial]);
    const res = await maybeFinalizeClassifierRun(db, "t1", "run-1");
    expect(res.finalized).toBe(false);
  });

  it("scores and completes the run once all docs are in", async () => {
    // query order: run, docRows, (claim update returns run-1), then update
    const { db, updates } = makeDb([RUN, DOCS]);
    const res = await maybeFinalizeClassifierRun(db, "t1", "run-1");
    expect(res.finalized).toBe(true);
    if (res.finalized) {
      expect(res.result.docsTotal).toBe(2);
      expect(res.result.docsCorrect).toBe(1);
      expect(res.result.accuracy).toBe(50);
    }
    // the completing update carries status completed + accuracy
    const completed = updates.find((u) => u.status === "completed");
    expect(completed).toBeTruthy();
    expect(completed.docsCorrect).toBe(1);
  });

  it("no-ops for a run already past queued/running (lost the claim)", async () => {
    const done = [{ status: "completed", docsTotal: 2, startedAt: null, createdAt: new Date() }];
    const { db } = makeDb([done]);
    const res = await maybeFinalizeClassifierRun(db, "t1", "run-1");
    expect(res.finalized).toBe(false);
  });
});
