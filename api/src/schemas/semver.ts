/**
 * Semver for schema versions.
 *
 * A schema version carries `major.minor.patch` plus an optional `prerelease`
 * tag (`"rc.N"`). A version is **released** iff `prerelease` is null, and a
 * **candidate** otherwise. Validate snapshots candidates (`v0.0.4-rc.7`);
 * promotion graduates one to a release (`v0.0.4`).
 *
 * Components are stored as sortable integer columns (semver strings don't sort
 * lexically), so this module is the single place that formats/parses/compares.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** e.g. "rc.7"; null for a released version. */
  prerelease: string | null;
}

export type Bump = "major" | "minor" | "patch";

/** `v1.2.3` or `v1.2.3-rc.7`. */
export function formatSemver(v: Semver): string {
  const base = `v${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

/**
 * `formatSemver` over components that may be null — the shape a LEFT JOIN
 * produces when there is no matching version row. Null in, null out.
 */
export function formatSemverLabel(v: {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: string | null;
}): string | null {
  if (v.major === null || v.minor === null || v.patch === null) return null;
  return formatSemver({ major: v.major, minor: v.minor, patch: v.patch, prerelease: v.prerelease });
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse `v1.2.3[-rc.7]` (leading `v` optional). Returns null if malformed. */
export function parseSemver(s: string): Semver | null {
  const m = SEMVER_RE.exec(s.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

export function isReleased(v: { prerelease: string | null }): boolean {
  return v.prerelease === null || v.prerelease === undefined;
}

/** Compare prerelease identifiers per semver §11 (numeric < numeric numerically). */
function comparePrerelease(a: string | null, b: string | null): number {
  // A release (no prerelease) outranks any prerelease of the same x.y.z.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const ai = as[i];
    const bi = bs[i];
    if (ai === undefined) return -1; // shorter set of fields = lower precedence
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return Math.sign(d);
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** Semver precedence: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch);
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** The released x.y.z a candidate targets, given the active release + bump. */
export function bumpTarget(
  active: { major: number; minor: number; patch: number },
  bump: Bump,
): { major: number; minor: number; patch: number } {
  if (bump === "major") return { major: active.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: active.major, minor: active.minor + 1, patch: 0 };
  return { major: active.major, minor: active.minor, patch: active.patch + 1 };
}

/**
 * Next `rc.N` for a target release, given the prerelease tags of existing
 * candidates that share that target x.y.z. Starts at 1.
 */
export function nextRcNumber(existingPrereleases: Array<string | null>): number {
  let max = 0;
  for (const p of existingPrereleases) {
    if (!p) continue;
    const m = /^rc\.(\d+)$/.exec(p);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
