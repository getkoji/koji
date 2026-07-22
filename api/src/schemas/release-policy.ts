/**
 * What a content-hash match means for the **live release pointer**.
 *
 * `releaseDirect` (schemas + classifiers) dedups by YAML hash: if a version
 * with this exact content already exists, it reuses that row rather than
 * creating a duplicate. That part is right. What was wrong is what it did
 * next — it unconditionally repointed `currentVersionId` at the matched row.
 *
 * So publishing content that happened to match an **older** version silently
 * moved the live release *backward*, and the caller got the same
 * `{ id, label }` + `201` it gets for a brand-new release. A bulk `koji push`
 * could therefore swap the live extraction schema for an earlier one and print
 * a success line. Nothing in the response said the pointer had moved at all.
 *
 * This module is the (pure, exhaustively tested) decision that fixes it:
 * given the matched version and the currently-live release, say which of the
 * four things is actually happening. Only `reactivate` displaces a *different*
 * live release, and only `reactivate` requires the caller to opt in.
 */
import { compareSemver, type Semver } from "./semver";

/** A version row as the policy sees it: semver components plus identity. */
export interface VersionIdentity extends Semver {
  id: string;
}

export type ReleaseMatch =
  /** The matched version is already the live release. Nothing to do. */
  | { action: "unchanged" }
  /** The matched version is a candidate — graduate it to a release and activate. */
  | { action: "graduate" }
  /** No live release to displace, so activating the match is not a rollback. */
  | { action: "activate" }
  /**
   * The matched version is a *different* already-released version. Activating
   * it displaces the current release; `backward` means it is a rollback. This
   * is the case that must never happen implicitly.
   */
  | { action: "reactivate"; direction: "forward" | "backward" };

/**
 * Decide what activating `matched` means, given the currently-live release.
 *
 * `current` is the release `currentVersionId` points at, or null when nothing
 * is live yet (a schema whose versions are all candidates, or a fresh artifact).
 */
export function classifyReleaseMatch(
  matched: VersionIdentity,
  current: VersionIdentity | null,
): ReleaseMatch {
  // Already live — publishing identical content is a no-op, not an "update".
  // Checked first so it wins even if the row is somehow a candidate: whatever
  // the pointer already references cannot be displaced by itself.
  if (current && matched.id === current.id) return { action: "unchanged" };

  // A candidate has never been live, so graduating it takes the pointer
  // forward by construction — the ordinary "release this rc" path.
  if (matched.prerelease !== null) return { action: "graduate" };

  // An existing release, and nothing live to lose.
  if (!current) return { action: "activate" };

  // An existing release that is not the live one: the pointer moves to a
  // version the caller did not necessarily ask for. Report which way it goes
  // so the refusal can name it.
  return {
    action: "reactivate",
    direction: compareSemver(matched, current) < 0 ? "backward" : "forward",
  };
}

/**
 * Does this outcome move the live pointer to a version the caller did not
 * explicitly ask for? Only `reactivate` does — the single case gated behind an
 * opt-in. Split out so both `releaseDirect` twins apply the same rule.
 */
export function requiresReactivateOptIn(match: ReleaseMatch): boolean {
  return match.action === "reactivate";
}

/**
 * The refusal a caller sees when publishing would move the live pointer to a
 * different existing release. Names both versions and the direction, because
 * "this content is already v2.0.5" is not actionable on its own — the caller
 * needs to know it would displace v2.0.9, and that going backward is a
 * rollback rather than an upgrade.
 */
export function reactivateRefusalMessage(r: {
  matched: { label: string };
  current: { label: string };
  direction: "forward" | "backward";
}): string {
  const move =
    r.direction === "backward"
      ? `would roll the live release BACK from ${r.current.label} to ${r.matched.label}`
      : `would move the live release from ${r.current.label} to ${r.matched.label}`;
  return `This content is already released as ${r.matched.label}, so publishing it ${move}. Promote ${r.matched.label} explicitly if that is what you want, or commit a change on top of ${r.current.label}.`;
}

/**
 * The 409 body for a refused reactivation. Shared by the schema and classifier
 * routes so both refuse identically, and structured (not just a message) so a
 * client can render the two versions without parsing prose.
 */
export function reactivateRefusalBody(r: {
  matched: { id: string; label: string };
  current: { id: string; label: string };
  direction: "forward" | "backward";
  hashedBytes?: number;
  hashedSha256Prefix?: string;
}) {
  return {
    error: reactivateRefusalMessage(r),
    reason: "requires_reactivate" as const,
    matched_version: r.matched.label,
    matched_version_id: r.matched.id,
    current_version: r.current.label,
    current_version_id: r.current.id,
    direction: r.direction,
    // Echo what was hashed. If these don't describe the payload you sent, your
    // content never reached the matcher — check the request body's field name
    // before acting on `matched_version`.
    hashed_bytes: r.hashedBytes,
    hashed_sha256_prefix: r.hashedSha256Prefix,
    hint:
      "Verify hashed_bytes matches the payload you sent. If it does, retry with allow_reactivate: true to move the live pointer deliberately; if it does not, your YAML did not reach the server under a recognized field.",
  };
}
