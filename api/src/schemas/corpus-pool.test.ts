/**
 * Unit tests for upsertCorpusDocument (oss-449) — find-or-create the pool row.
 *
 * withRLS is mocked to run against a queued fake DB, so we can drive the three
 * shapes that matter: the document already exists (dedup), it does not (create),
 * and two writers race the partial unique (create throws → read the winner).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, withRLS: (db: any, _scope: any, fn: (tx: any) => Promise<any>) => fn(db) };
});

const { upsertCorpusDocument } = await import("./corpus-pool");

const SCOPE = { tenantId: "t1", projectId: "p1" };
const INPUT = {
  tenantId: "t1",
  projectId: "p1",
  filename: "doc.pdf",
  storageKey: "k/doc.pdf",
  fileSize: 100,
  mimeType: "application/pdf",
  contentHash: "a".repeat(64),
  source: "upload",
  addedBy: "u1",
};

/**
 * Fake db. `selects` is a queue of results for each `.select()` chain;
 * `insertBehavior` either returns a row or throws (race). `inserted` records
 * whether an insert was attempted.
 */
function makeDb(opts: {
  selects: unknown[][];
  insert: { throws: true } | { id: string };
}) {
  const selectQueue = [...opts.selects];
  let insertAttempted = false;

  const selectChain = () => {
    const result = selectQueue.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(result),
      then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    };
    return chain;
  };

  const db: any = {
    select: () => selectChain(),
    insert: () => ({
      values: () => ({
        returning: () => {
          insertAttempted = true;
          if ("throws" in opts.insert) return Promise.reject(new Error("duplicate key"));
          return Promise.resolve([{ id: opts.insert.id }]);
        },
      }),
    }),
  };
  return { db, wasInsertAttempted: () => insertAttempted };
}

describe("upsertCorpusDocument", () => {
  it("returns the existing document without inserting when one is found", async () => {
    const { db, wasInsertAttempted } = makeDb({
      selects: [[{ id: "existing-doc" }]],
      insert: { id: "should-not-be-used" },
    });
    const id = await upsertCorpusDocument(db, SCOPE, INPUT);
    expect(id).toBe("existing-doc");
    expect(wasInsertAttempted()).toBe(false);
  });

  it("creates and returns a new document when none exists", async () => {
    const { db, wasInsertAttempted } = makeDb({
      selects: [[]], // no match
      insert: { id: "new-doc" },
    });
    const id = await upsertCorpusDocument(db, SCOPE, INPUT);
    expect(id).toBe("new-doc");
    expect(wasInsertAttempted()).toBe(true);
  });

  it("resolves a lost race by reading back the winner", async () => {
    // First select: empty (we think we must insert). Insert throws (someone
    // else won the partial unique). Second select: the winner's row.
    const { db } = makeDb({
      selects: [[], [{ id: "race-winner" }]],
      insert: { throws: true },
    });
    const id = await upsertCorpusDocument(db, SCOPE, INPUT);
    expect(id).toBe("race-winner");
  });

  it("rethrows when the insert fails for a reason other than a race", async () => {
    // Insert throws AND the re-read still finds nothing → a real error.
    const { db } = makeDb({
      selects: [[], []],
      insert: { throws: true },
    });
    await expect(upsertCorpusDocument(db, SCOPE, INPUT)).rejects.toThrow("duplicate key");
  });
});
