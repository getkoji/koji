/**
 * Auto-derive the semver bump between two normalized classifier configs by
 * diffing their **output contract** — the set of class labels a downstream
 * consumer of the classifier can receive.
 *
 *   - **major** — an existing label may disappear: a class removed. A caller
 *     branching on that label breaks.
 *   - **minor** — additive: a new class label appears. Safe for existing
 *     branches, but a new outcome is now possible.
 *   - **patch** — the label set is unchanged; only tuning changed (a class's
 *     description, keywords, patterns, per-class window, or the cost controls
 *     like `window`/`scan`/`max_tier`). Extraction-of-signal tuning, not a
 *     contract change.
 *
 * This is a heuristic — the caller may override it with an explicit `bump`.
 * Mirrors api/src/schemas/schema-diff.ts (which diffs a schema's `fields`).
 */
import type { Bump } from "../schemas/semver";

type Parsed = Record<string, unknown> | null | undefined;

/** The set of class ids declared by a normalized classifier config. */
function classIds(parsed: Parsed): Set<string> {
  const classes = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).classes : null;
  const ids = new Set<string>();
  if (Array.isArray(classes)) {
    for (const c of classes) {
      if (c && typeof c === "object") {
        const id = (c as Record<string, unknown>).id;
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Derive the bump from the active released classifier to a candidate. With no
 * active release yet (first version), returns "patch" — the caller decides the
 * initial version number (e.g. v0.0.1).
 */
export function deriveClassifierBump(activeParsed: Parsed, candidateParsed: Record<string, unknown>): Bump {
  if (!activeParsed) return "patch";
  const active = classIds(activeParsed);
  const candidate = classIds(candidateParsed);

  // A removed label breaks a downstream branch — major is the ceiling.
  for (const id of active) {
    if (!candidate.has(id)) return "major";
  }
  // A new label is additive.
  for (const id of candidate) {
    if (!active.has(id)) return "minor";
  }
  // Same label set — only tuning changed.
  return "patch";
}
