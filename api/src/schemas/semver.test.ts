import { describe, it, expect } from "vitest";
import {
  formatSemver,
  parseSemver,
  isReleased,
  compareSemver,
  bumpTarget,
  nextRcNumber,
  type Semver,
} from "./semver";

const v = (major: number, minor: number, patch: number, prerelease: string | null = null): Semver => ({
  major,
  minor,
  patch,
  prerelease,
});

describe("formatSemver / parseSemver", () => {
  it("formats released and prerelease versions", () => {
    expect(formatSemver(v(1, 2, 3))).toBe("v1.2.3");
    expect(formatSemver(v(0, 0, 4, "rc.7"))).toBe("v0.0.4-rc.7");
  });

  it("round-trips through parse", () => {
    expect(parseSemver("v0.0.4-rc.7")).toEqual(v(0, 0, 4, "rc.7"));
    expect(parseSemver("1.2.3")).toEqual(v(1, 2, 3));
    expect(parseSemver("not-a-version")).toBeNull();
  });
});

describe("isReleased", () => {
  it("true only when there is no prerelease tag", () => {
    expect(isReleased(v(1, 0, 0))).toBe(true);
    expect(isReleased(v(1, 0, 0, "rc.1"))).toBe(false);
  });
});

describe("compareSemver", () => {
  it("orders by major.minor.patch", () => {
    expect(compareSemver(v(0, 0, 9), v(0, 0, 10))).toBe(-1);
    expect(compareSemver(v(1, 0, 0), v(0, 9, 9))).toBe(1);
  });

  it("a release outranks its own prereleases", () => {
    expect(compareSemver(v(0, 0, 4), v(0, 0, 4, "rc.9"))).toBe(1);
    expect(compareSemver(v(0, 0, 4, "rc.2"), v(0, 0, 4))).toBe(-1);
  });

  it("orders rc numbers numerically (rc.2 < rc.10)", () => {
    expect(compareSemver(v(0, 0, 4, "rc.2"), v(0, 0, 4, "rc.10"))).toBe(-1);
  });
});

describe("bumpTarget", () => {
  const active = { major: 1, minor: 4, patch: 2 };
  it("major resets minor+patch", () => {
    expect(bumpTarget(active, "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });
  it("minor resets patch", () => {
    expect(bumpTarget(active, "minor")).toEqual({ major: 1, minor: 5, patch: 0 });
  });
  it("patch increments patch", () => {
    expect(bumpTarget(active, "patch")).toEqual({ major: 1, minor: 4, patch: 3 });
  });
});

describe("nextRcNumber", () => {
  it("starts at 1 with no prior candidates", () => {
    expect(nextRcNumber([])).toBe(1);
    expect(nextRcNumber([null, null])).toBe(1);
  });
  it("returns max rc + 1 (numeric, not lexical)", () => {
    expect(nextRcNumber(["rc.1", "rc.2", "rc.10"])).toBe(11);
  });
  it("ignores non-rc prerelease tags", () => {
    expect(nextRcNumber(["beta.5", "rc.3"])).toBe(4);
  });
});
