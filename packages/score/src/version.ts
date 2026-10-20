/**
 * The scorer's version, and the rule for comparing numbers across versions.
 *
 * Every result this package produces is stamped with `SCORER_VERSION`, because
 * a score is only meaningful relative to the code that produced it. Two runs
 * scored by different versions are not a measurement of the extraction — they
 * are a measurement of the extraction *plus* whatever the scorer changed, and
 * the two are not separable after the fact. So the stamp is not decoration:
 * callers are expected to refuse (or loudly flag) a comparison that crosses it.
 *
 * Kept as a literal rather than read from `package.json` at runtime. The API
 * bundles this module with esbuild, where `createRequire("../package.json")`
 * resolves against the bundle's location and not the package's, so a runtime
 * read is the kind of thing that works in tests and returns `undefined` in
 * production. `version.test.ts` asserts the literal matches `package.json`, so
 * the two cannot drift.
 */

/** This scorer's version. Bump it for ANY change in scoring semantics. */
export const SCORER_VERSION = "0.3.0";

/** The package name, so an artifact records which scorer, not just which version. */
export const SCORER_NAME = "@koji/score";

/**
 * Are two scorer versions comparable? Only when they are the same string.
 *
 * Deliberately not semver-aware. "Patch releases are comparable" sounds
 * reasonable and is false: a bug fix in date parsing moves numbers, which is
 * exactly the case a comparison guard exists to catch. Equality is the only
 * rule that cannot be wrong, and an unknown version (`undefined` — an artifact
 * written before stamping existed) is never comparable to anything.
 */
export function scorerVersionsComparable(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a === b;
}

/**
 * Throw unless `found` is this scorer's version.
 *
 * For callers whose whole operation IS a comparison (a regression gate, a
 * baseline diff, a benchmark delta). A caller that merely *displays* an old
 * artifact should warn instead — see `scorerVersionMismatch`.
 */
export function assertComparableScorerVersion(
  found: string | null | undefined,
  label = "artifact",
): void {
  const message = scorerVersionMismatch(found, label);
  if (message === null) return;
  throw new Error(message);
}

/**
 * The operator-facing explanation of a version mismatch, or `null` when the
 * versions match. Returning the message rather than throwing lets a read path
 * attach it as a warning instead of failing a request.
 */
export function scorerVersionMismatch(
  found: string | null | undefined,
  label = "artifact",
): string | null {
  if (scorerVersionsComparable(found, SCORER_VERSION)) return null;
  const which = found ? `scorer ${found}` : "an unrecorded scorer version";
  return (
    `${label} was scored by ${which}, but this is ${SCORER_NAME} ${SCORER_VERSION}. ` +
    `Numbers from different scorer versions are not comparable — the difference ` +
    `between them includes whatever the scorer changed, which cannot be separated ` +
    `from the extraction afterwards. Re-score the ${label} with this version before ` +
    `comparing.`
  );
}
