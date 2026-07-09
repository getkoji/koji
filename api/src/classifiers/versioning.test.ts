import { describe, it, expect } from "vitest";
import { nextReleaseTarget } from "./versioning";

describe("nextReleaseTarget", () => {
  it("starts a fresh classifier at v0.0.1", () => {
    expect(nextReleaseTarget(null, "patch")).toEqual({ major: 0, minor: 0, patch: 1 });
    expect(nextReleaseTarget(null, "minor")).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  it("bumps from the highest existing version, not a stale active pointer", () => {
    // The wedge: active is v0.0.1 but a v0.0.2 release already exists. A patch
    // change must land at v0.0.3, NOT re-target the occupied v0.0.2.
    const highest = { major: 0, minor: 0, patch: 2 };
    expect(nextReleaseTarget(highest, "patch")).toEqual({ major: 0, minor: 0, patch: 3 });
  });

  it("applies the bump level to the highest version", () => {
    const highest = { major: 1, minor: 4, patch: 2 };
    expect(nextReleaseTarget(highest, "patch")).toEqual({ major: 1, minor: 4, patch: 3 });
    expect(nextReleaseTarget(highest, "minor")).toEqual({ major: 1, minor: 5, patch: 0 });
    expect(nextReleaseTarget(highest, "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it("always produces a version strictly above the highest existing", () => {
    for (const highest of [
      { major: 0, minor: 0, patch: 1 },
      { major: 0, minor: 0, patch: 9 },
      { major: 2, minor: 3, patch: 4 },
    ]) {
      for (const bump of ["patch", "minor", "major"] as const) {
        const t = nextReleaseTarget(highest, bump);
        const gt =
          t.major > highest.major ||
          (t.major === highest.major && t.minor > highest.minor) ||
          (t.major === highest.major && t.minor === highest.minor && t.patch > highest.patch);
        expect(gt).toBe(true);
      }
    }
  });
});
