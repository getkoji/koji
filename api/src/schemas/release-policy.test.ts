import { describe, it, expect } from "vitest";
import {
  classifyReleaseMatch,
  reactivateRefusalMessage,
  requiresReactivateOptIn,
} from "./release-policy";

const v = (id: string, major: number, minor: number, patch: number, prerelease: string | null = null) => ({
  id,
  major,
  minor,
  patch,
  prerelease,
});

describe("classifyReleaseMatch", () => {
  it("reports unchanged when the match is already the live release", () => {
    const live = v("a", 2, 0, 9);
    expect(classifyReleaseMatch(live, live)).toEqual({ action: "unchanged" });
  });

  it("reports unchanged by identity, not by version components", () => {
    // Two rows can carry the same x.y.z only if one is a candidate; identity is
    // what decides whether the pointer would actually move.
    const matched = v("a", 1, 0, 0);
    const current = v("b", 1, 0, 0);
    expect(classifyReleaseMatch(matched, current).action).toBe("reactivate");
  });

  it("graduates a candidate — it has never been live, so this is not a rollback", () => {
    const candidate = v("cand", 2, 1, 0, "rc.3");
    const live = v("live", 2, 0, 9);
    expect(classifyReleaseMatch(candidate, live)).toEqual({ action: "graduate" });
  });

  it("graduates a candidate even when it sorts below the live release", () => {
    // rc for an older line: still a graduate, because the pointer has never
    // referenced this row. The rollback guard is about *released* versions.
    const candidate = v("cand", 1, 0, 0, "rc.1");
    const live = v("live", 2, 0, 9);
    expect(classifyReleaseMatch(candidate, live)).toEqual({ action: "graduate" });
  });

  it("activates when nothing is live yet", () => {
    expect(classifyReleaseMatch(v("a", 0, 0, 1), null)).toEqual({ action: "activate" });
  });

  it("flags a backward move to an older release — the reported P0", () => {
    // The field case: local YAML matched v2.0.5's content while v2.0.9 was live.
    const older = v("old", 2, 0, 5);
    const live = v("live", 2, 0, 9);
    expect(classifyReleaseMatch(older, live)).toEqual({
      action: "reactivate",
      direction: "backward",
    });
  });

  it("flags a forward move to a newer non-live release", () => {
    const newer = v("new", 3, 0, 0);
    const live = v("live", 2, 0, 9);
    expect(classifyReleaseMatch(newer, live)).toEqual({
      action: "reactivate",
      direction: "forward",
    });
  });

  it("detects a rollback across each semver component", () => {
    const live = v("live", 2, 3, 4);
    for (const older of [v("a", 1, 9, 9), v("b", 2, 2, 9), v("c", 2, 3, 3)]) {
      expect(classifyReleaseMatch(older, live)).toEqual({
        action: "reactivate",
        direction: "backward",
      });
    }
  });

  it("never silently displaces a different live release", () => {
    // The invariant the P0 violated: for every matched/current pair where the
    // pointer would move to a different *released* row, the outcome must be the
    // gated one. Nothing else may reach the live pointer implicitly.
    const live = v("live", 2, 0, 9);
    const others = [v("a", 1, 0, 0), v("b", 2, 0, 8), v("c", 2, 1, 0), v("d", 9, 9, 9)];
    for (const other of others) {
      const match = classifyReleaseMatch(other, live);
      expect(requiresReactivateOptIn(match)).toBe(true);
    }
  });
});

describe("reactivateRefusalMessage", () => {
  const args = { matched: { label: "v2.0.5" }, current: { label: "v2.0.9" } };

  it("calls a backward move a rollback and names both versions", () => {
    const msg = reactivateRefusalMessage({ ...args, direction: "backward" });
    expect(msg).toContain("v2.0.5");
    expect(msg).toContain("v2.0.9");
    expect(msg).toContain("BACK");
  });

  it("does not call a forward move a rollback", () => {
    const msg = reactivateRefusalMessage({
      matched: { label: "v3.0.0" },
      current: { label: "v2.0.9" },
      direction: "forward",
    });
    expect(msg).not.toContain("BACK");
    expect(msg).toContain("v3.0.0");
  });

  it("tells the caller what to do instead", () => {
    expect(reactivateRefusalMessage({ ...args, direction: "backward" })).toContain("Promote");
  });
});

describe("requiresReactivateOptIn", () => {
  it("gates only reactivate", () => {
    expect(requiresReactivateOptIn({ action: "unchanged" })).toBe(false);
    expect(requiresReactivateOptIn({ action: "graduate" })).toBe(false);
    expect(requiresReactivateOptIn({ action: "activate" })).toBe(false);
    expect(requiresReactivateOptIn({ action: "reactivate", direction: "forward" })).toBe(true);
    expect(requiresReactivateOptIn({ action: "reactivate", direction: "backward" })).toBe(true);
  });
});
