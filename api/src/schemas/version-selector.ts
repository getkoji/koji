/**
 * How to look up a single version from a `/versions/{v}` path segment.
 *
 * Both `GET /api/schemas/:slug/versions/:v` and the classifier equivalent used
 * `parseInt(param, 10)`, so a **semver label** — the identifier the sibling
 * `/versions` list hands you as its `version` field — parsed to `NaN` and the
 * query errored. Callers were given `v0.0.1` by one endpoint and could not
 * address it with the other.
 *
 * The selector accepts every form a caller plausibly holds: the numeric
 * `versionNumber`, a semver label with or without the leading `v`, and a
 * version-id prefix (matching `resolveClassifierConfig`'s pin semantics, so a
 * pin that works in a pipeline also works here).
 */
import { parseSemver } from "./semver";

export type VersionSelector =
  | { by: "number"; versionNumber: number }
  | { by: "semver"; label: string }
  | { by: "id"; prefix: string };

/** Uuid-ish: enough hex to be a meaningful prefix, and nothing else. */
const ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]{3,}$/i;

/**
 * Parse a `/versions/{v}` segment. Returns null when the segment is not a
 * usable identifier at all, which the route reports as a 400 rather than
 * running a query guaranteed to match nothing.
 */
export function parseVersionSelector(raw: string): VersionSelector | null {
  const v = raw.trim();
  if (!v) return null;

  // A bare integer is the versionNumber — the historical contract, kept first
  // so existing callers are unaffected.
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? { by: "number", versionNumber: n } : null;
  }

  // `v1.2.3`, `1.2.3`, `v1.2.3-rc.7` — normalize to the canonical label so the
  // caller can compare against formatSemver output directly.
  const semver = parseSemver(v);
  if (semver) {
    const base = `v${semver.major}.${semver.minor}.${semver.patch}`;
    return { by: "semver", label: semver.prerelease ? `${base}-${semver.prerelease}` : base };
  }

  if (ID_PREFIX_RE.test(v)) return { by: "id", prefix: v };
  return null;
}
