/**
 * Auto-derive the semver bump between two compiled schemas by diffing their
 * **output shape** — the contract a downstream consumer of the extracted data
 * relies on.
 *
 *   - **major** — an existing output may break: a field removed, its `type`
 *     changed, `required: true → false` (the field may now be absent), or a
 *     nested array-item/object child removed or retyped.
 *   - **minor** — additive or stricter, safe for existing consumers: a field
 *     added, a nested child added, an enum/`values` domain changed, or
 *     `required: false → true`.
 *   - **patch** — no shape change: same fields, types, and requiredness; only
 *     guidance/`normalize`/`validate`/`description`/hints changed (extraction
 *     tuning).
 *
 * This is a heuristic — `koji validate --bump` and the promote command let a
 * human override it. Properties that don't affect output shape are ignored.
 */
import { arrayItemProperties, objectProperties } from "../extract/schema-tree";
import type { Bump } from "./semver";

type FieldSpec = Record<string, unknown>;
type FieldMap = Record<string, FieldSpec>;

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };
const stronger = (a: Bump, b: Bump): Bump => (RANK[a] >= RANK[b] ? a : b);

function fieldsOf(parsed: Record<string, unknown> | null | undefined): FieldMap {
  const f = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).fields : null;
  return f && typeof f === "object" ? (f as FieldMap) : {};
}

function enumValues(spec: FieldSpec): Set<string> | null {
  const v = spec.values ?? spec.enum ?? spec.options;
  return Array.isArray(v) ? new Set(v.map(String)) : null;
}

/** The nested field map of an array-of-objects or object-typed spec, if any. */
function childMap(spec: FieldSpec): FieldMap | null {
  return arrayItemProperties(spec) ?? objectProperties(spec);
}

function setsDiffer(a: Set<string> | null, b: Set<string> | null): boolean {
  if (!a || !b) return false;
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}

/** Compare two field maps; return the strongest bump implied. */
function diffFieldMaps(active: FieldMap, candidate: FieldMap): Bump {
  // A removed (or renamed-away) field is the strongest signal — major is the
  // ceiling, so we can stop.
  for (const name of Object.keys(active)) {
    if (!(name in candidate)) return "major";
  }

  let bump: Bump = "patch";
  for (const [name, cand] of Object.entries(candidate)) {
    const act = active[name];
    if (!act) {
      bump = stronger(bump, "minor"); // added field
      continue;
    }
    if (String(cand.type ?? "") !== String(act.type ?? "")) return "major"; // retyped
    if (act.required === true && cand.required !== true) return "major"; // required → optional
    if (act.required !== true && cand.required === true) bump = stronger(bump, "minor"); // tightened
    if (setsDiffer(enumValues(act), enumValues(cand))) bump = stronger(bump, "minor"); // enum domain

    const ac = childMap(act);
    const cc = childMap(cand);
    if (ac && cc) bump = stronger(bump, diffFieldMaps(ac, cc));
    else if (ac && !cc) return "major"; // lost nested structure
    else if (!ac && cc) bump = stronger(bump, "minor"); // gained nested structure
  }
  return bump;
}

/**
 * Derive the bump from the active released schema to a candidate. With no active
 * release yet (first version), returns "patch" — the caller decides the initial
 * version number (e.g. v0.0.1).
 */
export function deriveBump(
  activeParsed: Record<string, unknown> | null | undefined,
  candidateParsed: Record<string, unknown>,
): Bump {
  if (!activeParsed) return "patch";
  return diffFieldMaps(fieldsOf(activeParsed), fieldsOf(candidateParsed));
}
