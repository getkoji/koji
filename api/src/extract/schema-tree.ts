/**
 * Shared schema-tree traversal primitives.
 *
 * Several stages walk the schema tree: prompt rendering (group-extract),
 * field validation (pipeline.validateField), normalization (normalize), and
 * post-extract validation (validate). Historically each implemented its own
 * descent logic, so type coercion, mapping/enum resolution, and vocabulary
 * hints silently stopped working below the top level — a `type: mapping` or
 * `number` field inside an array item was a no-op.
 *
 * These helpers give every stage ONE definition of "how do I descend into this
 * field" and "what is this field's controlled vocabulary", so a field spec is
 * processed identically regardless of nesting depth.
 */

export type FieldSpec = Record<string, unknown>;

/**
 * If `spec` is an array whose items are objects carrying a `properties` map,
 * return that map (the per-item field specs). Otherwise null.
 *
 * Matches the long-standing normalize.ts behavior: any `items` object carrying a
 * `properties` map is treated as array-of-objects, regardless of an explicit
 * `items.type`.
 */
export function arrayItemProperties(
  spec: FieldSpec | null | undefined,
): Record<string, FieldSpec> | null {
  if (!spec || typeof spec !== "object") return null;
  const items = spec.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) return null;
  const props = (items as FieldSpec).properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    return props as Record<string, FieldSpec>;
  }
  return null;
}

/**
 * If `spec` is a nested object (`type: object`) carrying a `properties` map,
 * return it. Otherwise null.
 */
export function objectProperties(
  spec: FieldSpec | null | undefined,
): Record<string, FieldSpec> | null {
  if (!spec || typeof spec !== "object") return null;
  if (spec.type !== "object") return null;
  const props = spec.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    return props as Record<string, FieldSpec>;
  }
  return null;
}

/**
 * The controlled-vocabulary hint for a field, rendered for the extraction
 * prompt:
 *   " [pick from: a (alias1, alias2), b]"   (mapping type)
 *   " [pick from: x, y, z]"                 (enum / options)
 * Returns "" when the field declares no controlled vocabulary.
 *
 * Used for both top-level and nested fields so the model is told the allowed
 * values at any depth.
 */
export function vocabHint(spec: FieldSpec | null | undefined): string {
  if (!spec || typeof spec !== "object") return "";

  // Conditional vocabulary: the allowed values depend on a sibling field. The
  // per-row sibling value isn't known at prompt-build time (an array's rows all
  // come from one call), so render the whole decision table as guidance and let
  // resolveVocab enforce the right branch deterministically after extraction.
  const condHint = conditionalVocabHint(spec);
  if (condHint) return condHint;

  const bare = bareVocab(spec);
  return bare ? ` [pick from: ${bare}]` : "";
}

/** The inner text of a vocabulary hint (no brackets/prefix): "a (alias), b" or
 *  "x, y, z". Empty string when the spec declares no static vocabulary. */
function bareVocab(spec: FieldSpec): string {
  const mappings = spec.mappings as Record<string, unknown[]> | undefined;
  if (mappings && typeof mappings === "object" && Object.keys(mappings).length > 0) {
    const parts: string[] = [];
    for (const [canonical, aliases] of Object.entries(mappings)) {
      const aliasList = (Array.isArray(aliases) ? aliases : [])
        .filter((a) => String(a) !== String(canonical))
        .map(String)
        .join(", ");
      parts.push(aliasList ? `${canonical} (${aliasList})` : String(canonical));
    }
    return parts.join(", ");
  }
  const options = (spec.options ?? spec.enum) as unknown[] | undefined;
  if (Array.isArray(options) && options.length > 0) {
    return options.map(String).join(", ");
  }
  return "";
}

/** Render a `vocab_by` decision table as a prompt hint, or "" if absent/empty. */
function conditionalVocabHint(spec: FieldSpec): string {
  const byField = spec.vocab_by;
  if (!byField || typeof byField !== "object" || Array.isArray(byField)) return "";
  const groups: string[] = [];
  for (const [sibling, cases] of Object.entries(byField as Record<string, unknown>)) {
    if (!cases || typeof cases !== "object" || Array.isArray(cases)) continue;
    const branches: string[] = [];
    for (const [value, vocab] of Object.entries(cases as Record<string, unknown>)) {
      const inner = bareVocab((vocab ?? {}) as FieldSpec);
      if (inner) branches.push(`${value} → ${inner}`);
    }
    if (branches.length) groups.push(`pick by ${sibling}: ${branches.join("; ")}`);
  }
  if (!groups.length) return "";
  const def = bareVocab((spec.vocab_default ?? {}) as FieldSpec);
  const tail = def ? `; otherwise: ${def}` : "";
  return ` [${groups.join(" | ")}${tail}]`;
}

/**
 * The outcome of resolving a field's effective vocabulary against its siblings.
 * - `static`: the field has no `vocab_by`; its own spec is returned unchanged.
 * - `matched`: a `vocab_by` branch matched a sibling value.
 * - `default`: no branch matched, but a `vocab_default` was applied.
 * - `unmatched`: `vocab_by` is present, nothing matched, and there is no default.
 */
export type VocabStatus = "static" | "matched" | "default" | "unmatched";

export interface ResolvedVocab {
  spec: FieldSpec;
  status: VocabStatus;
  /** For matched/unmatched: the sibling field and value that drove the choice. */
  sibling?: { field: string; value: unknown };
}

/**
 * Select a field's effective vocabulary from `vocab_by` based on the values of
 * its sibling fields (the enclosing object/row). Returns a spec whose
 * `mappings`/`options` reflect the chosen branch, ready for the normal
 * mapping/enum resolution in {@link validateField}.
 *
 * Mirrors `extraction_hint_by` semantics: iterate the declared sibling fields,
 * first one whose current value matches a declared branch wins. Falls back to
 * `vocab_default`, then to the field's own static vocabulary.
 */
export function resolveVocab(
  spec: FieldSpec | null | undefined,
  siblings: Record<string, unknown>,
): ResolvedVocab {
  if (!spec || typeof spec !== "object" || !spec.vocab_by) {
    return { spec: (spec ?? {}) as FieldSpec, status: "static" };
  }
  const byField = spec.vocab_by as Record<string, unknown>;
  for (const [sibling, cases] of Object.entries(byField)) {
    if (!cases || typeof cases !== "object" || Array.isArray(cases)) continue;
    const value = siblings?.[sibling];
    if (value === null || value === undefined) continue;
    const caseMap = cases as Record<string, unknown>;
    const branch = (caseMap[value as string] ?? caseMap[String(value)]) as FieldSpec | undefined;
    if (branch && typeof branch === "object") {
      return { spec: mergeVocab(spec, branch), status: "matched", sibling: { field: sibling, value } };
    }
  }
  const def = spec.vocab_default as FieldSpec | undefined;
  if (def && typeof def === "object") {
    return { spec: mergeVocab(spec, def), status: "default" };
  }
  // Nothing matched and no default: strip any stale vocabulary so the value is
  // left as-is, and signal so the caller can flag it.
  const sibling = Object.keys(byField)[0];
  return {
    spec: stripVocab(spec),
    status: "unmatched",
    sibling: sibling ? { field: sibling, value: siblings?.[sibling] } : undefined,
  };
}

/**
 * Overlay a branch's vocabulary (`mappings`/`options`/`values`/`enum`) onto a
 * spec. The conditional keys are removed so the result renders and resolves as a
 * plain field with a concrete vocabulary.
 */
function mergeVocab(spec: FieldSpec, branch: FieldSpec): FieldSpec {
  const out = stripVocab(spec);
  if (branch.mappings) out.mappings = branch.mappings;
  const opts = branch.options ?? branch.values ?? branch.enum;
  if (opts) out.options = opts;
  return out;
}

/** Remove all static and conditional vocabulary keys from a spec. */
function stripVocab(spec: FieldSpec): FieldSpec {
  const out: FieldSpec = { ...spec };
  delete out.mappings;
  delete out.options;
  delete out.enum;
  delete out.vocab_by;
  delete out.vocab_default;
  return out;
}
