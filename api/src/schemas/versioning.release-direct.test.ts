/**
 * Regression tests for the `releaseDirect` live-pointer guard.
 *
 * The P0 these lock down: `releaseDirect` dedups by YAML content hash, and it
 * used to repoint `schemas.currentVersionId` at *whatever* row matched. So
 * publishing content that matched an older version silently rolled the live
 * release backward and returned the same shape as an ordinary new release —
 * a bulk `koji push` could swap the live extraction schema and print success.
 *
 * `withRLS` is mocked so the queued select results stand in for the DB, in the
 * same idiom as ./routes/classifiers.test.ts. What matters here is *which
 * writes happen*: `updates` captures every `.set()`, so "the live pointer did
 * not move" is directly assertable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withRLS: (_db: any, _scope: any, fn: (tx: any) => Promise<any>) => fn(_db),
  };
});

const { releaseDirect } = await import("./versioning");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const SCHEMA_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000099";

const LIVE_ID = "00000000-0000-0000-0000-0000000002a9"; // v2.0.9, the live release
const OLDER_ID = "00000000-0000-0000-0000-0000000002a5"; // v2.0.5, an older release

/** Chainable, awaitable query stub; `updates` records every `.set()` payload. */
function makeMockDb(selectResults: unknown[][], insertReturning: unknown[] = []) {
  const selectQueue = [...selectResults];
  const updates: Record<string, unknown>[] = [];

  function selectChain() {
    const result = selectQueue.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(result),
      then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    };
    return chain;
  }

  const db: any = {
    select: () => selectChain(),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        const chain: any = {
          where: () => chain,
          returning: () => Promise.resolve([]),
          then: (res: any, rej: any) => Promise.resolve([]).then(res, rej),
        };
        return chain;
      },
    }),
    insert: () => ({
      values: () => ({
        returning: () => ({
          catch: () => Promise.resolve(insertReturning),
        }),
      }),
    }),
  };
  return { db, updates };
}

const liveRow = {
  id: LIVE_ID,
  major: 2,
  minor: 0,
  patch: 9,
  prerelease: null,
  parsedJson: { fields: {} },
};

/** Query order in releaseDirect: currentVersionId → active row → hash match. */
function queues(match: unknown | null) {
  return [[{ currentVersionId: LIVE_ID }], [liveRow], match ? [match] : []];
}

function call(db: any, allowReactivate?: boolean) {
  return releaseDirect(db, TENANT_ID, {
    schemaId: SCHEMA_ID,
    yaml: "fields: {}\n",
    parsed: { fields: {} },
    userId: USER_ID,
    ...(allowReactivate === undefined ? {} : { allowReactivate }),
  } as any);
}

describe("releaseDirect — live pointer guard", () => {
  let mock: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("REFUSES to roll the live release backward, and writes nothing", async () => {
    // The field case: local YAML matched v2.0.5 while v2.0.9 was live.
    mock = makeMockDb(
      queues({ id: OLDER_ID, versionNumber: 5, major: 2, minor: 0, patch: 5, prerelease: null }),
    );
    const res: any = await call(mock.db);

    expect(res.error).toBe("requires_reactivate");
    expect(res.direction).toBe("backward");
    expect(res.matched.label).toBe("v2.0.5");
    expect(res.current.label).toBe("v2.0.9");
    // The whole point: the live pointer was never touched.
    expect(mock.updates).toEqual([]);
  });

  it("refuses a forward move to a different existing release too", async () => {
    mock = makeMockDb(
      queues({ id: "other", versionNumber: 12, major: 3, minor: 0, patch: 0, prerelease: null }),
    );
    const res: any = await call(mock.db);

    expect(res.error).toBe("requires_reactivate");
    expect(res.direction).toBe("forward");
    expect(mock.updates).toEqual([]);
  });

  it("moves the pointer only when the caller opts in, and reports what it displaced", async () => {
    mock = makeMockDb(
      queues({ id: OLDER_ID, versionNumber: 5, major: 2, minor: 0, patch: 5, prerelease: null }),
    );
    const res: any = await call(mock.db, true);

    expect(res.action).toBe("reactivated");
    expect(res.label).toBe("v2.0.5");
    expect(res.displaced).toEqual({ id: LIVE_ID, label: "v2.0.9" });
    expect(mock.updates).toContainEqual(
      expect.objectContaining({ currentVersionId: OLDER_ID }),
    );
  });

  it("reports republishing the live version as unchanged, touching nothing", async () => {
    // Fixes the other half of the report: push printed "updated" for a no-op.
    mock = makeMockDb(
      queues({ id: LIVE_ID, versionNumber: 9, major: 2, minor: 0, patch: 9, prerelease: null }),
    );
    const res: any = await call(mock.db);

    expect(res.action).toBe("unchanged");
    expect(res.label).toBe("v2.0.9");
    expect(res.displaced).toBeNull();
    // Notably: updatedAt is NOT bumped — a no-op must not look like a write.
    expect(mock.updates).toEqual([]);
  });

  it("still graduates a candidate to live — the ordinary release path", async () => {
    mock = makeMockDb(
      queues({ id: "cand", versionNumber: 10, major: 2, minor: 1, patch: 0, prerelease: "rc.3" }),
    );
    const res: any = await call(mock.db);

    expect(res.action).toBe("graduated");
    expect(res.label).toBe("v2.1.0");
    expect(mock.updates).toContainEqual(expect.objectContaining({ prerelease: null }));
    expect(mock.updates).toContainEqual(expect.objectContaining({ currentVersionId: "cand" }));
  });

  it("creates and activates a new release when nothing matches the content", async () => {
    mock = makeMockDb(queues(null), [
      { id: "fresh", versionNumber: 11, major: 2, minor: 0, patch: 10, prerelease: null },
    ]);
    const res: any = await call(mock.db);

    expect(res.action).toBe("created");
    expect(res.label).toBe("v2.0.10");
    expect(res.displaced).toEqual({ id: LIVE_ID, label: "v2.0.9" });
    expect(mock.updates).toContainEqual(expect.objectContaining({ currentVersionId: "fresh" }));
  });
});

/**
 * The `insurance_quote` 500 (oss-462), reproduced from production state.
 *
 * A schema had BOTH a released v1.0.2 and a candidate v1.0.2-rc.1 whose content
 * matched what `koji push` was posting. releaseDirect hash-matched the
 * candidate and graduated it by clearing its prerelease — turning it into a
 * second released v1.0.2, which the partial unique index
 * `schema_versions_released_semver_idx` rejects. Nothing caught the rejection,
 * so the caller got a 500 instead of a refusal.
 */
describe("releaseDirect — graduating onto an occupied release slot", () => {
  const LIVE_ID = "00000000-0000-0000-0000-0000000002a9";
  const CAND_ID = "00000000-0000-0000-0000-0000000002c1";

  /** currentVersionId → active row → hash match (the candidate) → clash probe. */
  function queues(clash: unknown[]) {
    return [
      [{ currentVersionId: LIVE_ID }],
      [{ id: LIVE_ID, major: 2, minor: 0, patch: 9, prerelease: null, parsedJson: { fields: {} } }],
      [{ id: CAND_ID, versionNumber: 7, major: 1, minor: 0, patch: 2, prerelease: "rc.1" }],
      clash,
    ];
  }

  it("refuses instead of 500ing when a release already occupies that x.y.z", async () => {
    const mock = makeMockDb(queues([{ id: "released-1-0-2" }]));
    const res: any = await releaseDirect(mock.db, TENANT_ID, {
      schemaId: SCHEMA_ID,
      yaml: "fields: {}\n",
      parsed: { fields: {} },
      userId: USER_ID,
    } as any);

    expect(res.error).toBe("already_released");
    // Critically: the candidate was NOT mutated, so no constraint was hit.
    expect(mock.updates).toEqual([]);
  });

  it("still graduates the candidate when the slot is free", async () => {
    const mock = makeMockDb(queues([]));
    const res: any = await releaseDirect(mock.db, TENANT_ID, {
      schemaId: SCHEMA_ID,
      yaml: "fields: {}\n",
      parsed: { fields: {} },
      userId: USER_ID,
    } as any);

    expect(res.action).toBe("graduated");
    expect(res.label).toBe("v1.0.2");
    expect(mock.updates).toContainEqual(expect.objectContaining({ prerelease: null }));
    expect(mock.updates).toContainEqual(expect.objectContaining({ currentVersionId: CAND_ID }));
  });
});
