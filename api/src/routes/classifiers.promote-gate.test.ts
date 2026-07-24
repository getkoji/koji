/**
 * Route tests for the classifier promote regression gate (oss-464).
 *
 * The gate's arithmetic is unit-tested in ../classifiers/release-gate.test.ts;
 * here we drive it THROUGH the promote route with real gate logic (only
 * graduateCandidate is mocked) to pin the wiring: which runs are read as
 * candidate vs. baseline, the no-backtest refusal, the 409 block payload, and
 * that a clean gate still graduates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, withRLS: (db: any, _scope: any, fn: (tx: any) => Promise<any>) => fn(db) };
});

vi.mock("../classifiers/versioning", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, graduateCandidate: vi.fn(async () => ({ label: "v1.3.0" })) };
});

const { classifiers } = await import("./classifiers");
const { graduateCandidate } = await import("../classifiers/versioning");

const TENANT = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-4000-8000-00000000aaaa";
const CLS_ID = "00000000-0000-0000-0000-0000000000c1";
const CAND = "cand-version-id";
const LIVE = "live-version-id";

function runResult(byClass: Array<{ label: string; recall: number | null; precision: number | null }>) {
  return {
    resultJson: {
      docsTotal: 10,
      docsCorrect: 9,
      docsFailed: 0,
      accuracy: 90,
      byClass: byClass.map((c) => ({ ...c, support: 5, predicted: 5, tp: 4, fp: 0, fn: 0, f1: null })),
      confusion: [],
      tierHistogram: {},
      escalationRate: null,
      flips: { fixed: 0, regressed: 0, churned: 0, items: [] },
      costUsd: null,
    },
  };
}

/** Chainable/awaitable select mock; each select() shifts the next queued result. */
function makeDb(selects: unknown[][]) {
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
  return { select: () => chain() };
}

function app(db: any) {
  const a = new Hono<Env>();
  a.use("*", async (c, next) => {
    c.set("tenantId", TENANT as any);
    c.set("projectId", PROJECT as any);
    c.set("principal", { userId: "u1" } as any);
    c.set("grants", new Set(["schema:deploy"]) as any);
    c.set("roles", ["owner"] as any);
    c.set("db", db);
    await next();
  });
  a.route("/api/classifiers", classifiers);
  return a;
}

function promote(db: any, body: unknown) {
  return app(db).request("/api/classifiers/docs/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// classifier row carries the live release as currentVersionId (the baseline).
const CLS_ROW = [{ id: CLS_ID, currentVersionId: LIVE }];

beforeEach(() => vi.clearAllMocks());

describe("POST /:slug/promote — regression gate", () => {
  it("promotes ungated when no gate fields are sent", async () => {
    const res = await promote(makeDb([CLS_ROW]), { versionId: CAND });
    expect(res.status).toBe(200);
    expect(graduateCandidate).toHaveBeenCalledOnce();
  });

  it("refuses with 409 when a gate is requested but the candidate has no backtest", async () => {
    // classifier row, then candidate-run lookup returns nothing.
    const res = await promote(makeDb([CLS_ROW, []]), { versionId: CAND, requireNoRegressions: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("no completed backtest");
    expect(graduateCandidate).not.toHaveBeenCalled();
  });

  it("blocks the field-reported failure: a named class regressing vs the live release", async () => {
    // candidate: policy up, coi recall down 100%→91%; baseline: coi 100%.
    const candidate = runResult([
      { label: "coi", recall: 0.91, precision: 0.8 },
      { label: "policy", recall: 0.87, precision: 0.9 },
    ]);
    const baseline = runResult([
      { label: "coi", recall: 1.0, precision: 1.0 },
      { label: "policy", recall: 0.5, precision: 0.9 },
    ]);
    const res = await promote(makeDb([CLS_ROW, [candidate], [baseline]]), {
      versionId: CAND,
      mustNotRegress: ["coi"],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toContain("coi recall regressed 100% → 91%");
    expect(body.blocked.some((b: any) => b.class === "coi" && b.metric === "recall")).toBe(true);
    expect(graduateCandidate).not.toHaveBeenCalled();
  });

  it("allows the promotion when the guarded class holds", async () => {
    const candidate = runResult([{ label: "coi", recall: 1.0, precision: 1.0 }]);
    const baseline = runResult([{ label: "coi", recall: 1.0, precision: 1.0 }]);
    const res = await promote(makeDb([CLS_ROW, [candidate], [baseline]]), {
      versionId: CAND,
      mustNotRegress: ["coi"],
    });
    expect(res.status).toBe(200);
    expect(graduateCandidate).toHaveBeenCalledOnce();
  });

  it("enforces an absolute floor even with no baseline (first release)", async () => {
    const candidate = runResult([{ label: "coi", recall: 0.8, precision: 1.0 }]);
    // classifier has no live release yet.
    const clsNoLive = [{ id: CLS_ID, currentVersionId: null }];
    const res = await promote(makeDb([clsNoLive, [candidate]]), {
      versionId: CAND,
      minRecall: { coi: 0.9 },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("below the required floor");
    expect(graduateCandidate).not.toHaveBeenCalled();
  });
});
