import { describe, it, expect } from "vitest";
import { parseVersionSelector, selectValidateVersion } from "./version-selector";

describe("parseVersionSelector", () => {
  it("reads a bare integer as the versionNumber (the historical contract)", () => {
    expect(parseVersionSelector("3")).toEqual({ by: "number", versionNumber: 3 });
    expect(parseVersionSelector("0")).toEqual({ by: "number", versionNumber: 0 });
  });

  it("reads the semver label the /versions list hands out — the reported bug", () => {
    // GET /versions returns `version: "v0.0.1"`; GET /versions/v0.0.1 used to
    // parseInt that to NaN and error.
    expect(parseVersionSelector("v0.0.1")).toEqual({ by: "semver", label: "v0.0.1" });
  });

  it("accepts a semver label without the leading v", () => {
    expect(parseVersionSelector("0.0.3")).toEqual({ by: "semver", label: "v0.0.3" });
  });

  it("accepts a release candidate label", () => {
    expect(parseVersionSelector("v1.2.0-rc.7")).toEqual({ by: "semver", label: "v1.2.0-rc.7" });
  });

  it("normalizes to the canonical label so it compares to formatSemver output", () => {
    expect(parseVersionSelector("1.2.3")).toEqual({ by: "semver", label: "v1.2.3" });
    expect(parseVersionSelector("v1.2.3")).toEqual({ by: "semver", label: "v1.2.3" });
  });

  it("reads a version-id prefix, matching pipeline pin semantics", () => {
    expect(parseVersionSelector("a1b2c3d4")).toEqual({ by: "id", prefix: "a1b2c3d4" });
    expect(parseVersionSelector("00000000-0000")).toEqual({ by: "id", prefix: "00000000-0000" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseVersionSelector("  v0.0.1  ")).toEqual({ by: "semver", label: "v0.0.1" });
  });

  it("rejects segments that cannot identify a version", () => {
    for (const bad of ["", "   ", "latest", "v", "1.2", "!!", "zz"]) {
      expect(parseVersionSelector(bad)).toBeNull();
    }
  });

  it("never returns NaN for a versionNumber", () => {
    // The precise shape of the original defect.
    for (const input of ["v0.0.1", "0.0.3", "abc123", "latest"]) {
      const sel = parseVersionSelector(input);
      if (sel?.by === "number") expect(Number.isNaN(sel.versionNumber)).toBe(false);
    }
  });
});

describe("selectValidateVersion", () => {
  // Newest-first, as the query returns them. #5 is an rc that a previous
  // `koji validate <file>` snapshotted; #4 is what's actually live.
  const rows = [
    { id: "v5", label: "0.0.3-rc.3" },
    { id: "v4", label: "0.0.3" },
    { id: "v1", label: "0.0.1" },
  ];

  it("picks the RELEASED version, not the newest row", () => {
    expect(selectValidateVersion(rows, "v4")?.label).toBe("0.0.3");
  });

  it("falls back to the newest version when nothing is released", () => {
    expect(selectValidateVersion(rows, null)?.label).toBe("0.0.3-rc.3");
  });

  it("falls back when the released id isn't among the rows", () => {
    expect(selectValidateVersion(rows, "gone")?.label).toBe("0.0.3-rc.3");
  });

  it("returns undefined for a schema with no versions at all", () => {
    expect(selectValidateVersion([], "v4")).toBeUndefined();
  });
});
