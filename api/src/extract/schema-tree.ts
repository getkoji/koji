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
    return ` [pick from: ${parts.join(", ")}]`;
  }
  const options = (spec.options ?? spec.enum) as unknown[] | undefined;
  if (Array.isArray(options) && options.length > 0) {
    return ` [pick from: ${options.map(String).join(", ")}]`;
  }
  return "";
}
