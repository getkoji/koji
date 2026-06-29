/**
 * Tests for the review → corpus promotion contract.
 *
 * The promotion handler's safety-critical logic — who may promote, and whether
 * the resulting label is scored by `validate` — is extracted into the pure
 * `resolvePromotion` helper so it can be pinned without a database. These tests
 * lock the invariant that an agent cannot grade its own homework: provisional
 * (agent-authored) labels are always `draft` and are NEVER written to the
 * denormalized ground truth that `validate` scores.
 *
 * Permission gating mirrors the route's `requires("corpus:write")` guard.
 */
import { describe, it, expect } from "vitest";
import { resolvePromotion, isUuid } from "./review";
import { resolvePermissions } from "../auth/roles";

describe("isUuid — malformed ids are rejected (→ 404, not a Postgres 500)", () => {
  it("accepts a well-formed uuid", () => {
    expect(isUuid("94f9271d-4d16-40e3-a6c6-6217398a8242")).toBe(true);
  });

  it("rejects the 8-char prefix shown in `review ls`", () => {
    // The exact footgun that crashed prod: a truncated id reaching the uuid cast.
    expect(isUuid("e100cad1")).toBe(false);
  });

  it("rejects other malformed ids", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("94f9271d-4d16-40e3-a6c6-6217398a8242-extra")).toBe(false);
  });
});

describe("resolvePromotion — gating", () => {
  it("rejects human-gated promotion of an unresolved item (409 path)", () => {
    const d = resolvePromotion({ provisional: false, status: "pending", resolution: null });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/resolved and approved/i);
  });

  it("rejects human-gated promotion of a resolved-but-rejected item", () => {
    const d = resolvePromotion({ provisional: false, status: "completed", resolution: "rejected" });
    expect(d.ok).toBe(false);
  });

  it("allows human-gated promotion of a completed + approved item", () => {
    const d = resolvePromotion({ provisional: false, status: "completed", resolution: "approved" });
    expect(d.ok).toBe(true);
  });

  it("allows provisional promotion regardless of status", () => {
    for (const status of ["pending", "in_review", "completed"]) {
      const d = resolvePromotion({ provisional: true, status, resolution: null });
      expect(d.ok).toBe(true);
    }
  });
});

describe("resolvePromotion — draft/approved + validate-exclusion invariant", () => {
  it("human-gated → approved label, written to the scored ground truth", () => {
    const d = resolvePromotion({ provisional: false, status: "completed", resolution: "approved" });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.reviewStatus).toBe("approved");
      expect(d.authoredViaAgent).toBe(false);
      expect(d.writeDenormalizedGt).toBe(true); // counts in validate
    }
  });

  it("provisional → draft label, EXCLUDED from the scored ground truth", () => {
    const d = resolvePromotion({ provisional: true, status: "pending", resolution: null });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.reviewStatus).toBe("draft");
      expect(d.authoredViaAgent).toBe(true);
      // The whole safety property: an agent label never reaches validate until
      // a human approves the draft.
      expect(d.writeDenormalizedGt).toBe(false);
    }
  });
});

describe("review promotion — permission gating", () => {
  // `review promote` is gated on corpus:promote — the reviewer persona, who
  // works the queue, holds it (alongside review:act) without needing the
  // broader corpus:write.
  it("reviewer can promote reviewed docs (corpus:promote)", () => {
    expect(resolvePermissions(["reviewer"]).has("corpus:promote")).toBe(true);
  });

  it("a read-only viewer cannot promote", () => {
    expect(resolvePermissions(["viewer"]).has("corpus:promote")).toBe(false);
  });

  // Approving a draft into the validated set is corpus authoring — gated on
  // the stronger corpus:write, which starts at schema-editor (a reviewer can
  // create drafts but not approve them).
  it("approving a draft requires corpus:write (schema-editor+, not reviewer)", () => {
    expect(resolvePermissions(["schema-editor"]).has("corpus:write")).toBe(true);
    expect(resolvePermissions(["reviewer"]).has("corpus:write")).toBe(false);
    expect(resolvePermissions(["viewer"]).has("corpus:write")).toBe(false);
  });
});
