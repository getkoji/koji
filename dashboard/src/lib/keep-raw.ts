/**
 * `keep_raw` companion handling for extracted-data views.
 *
 * The extraction engine emits a `<field>_raw` companion (the document's verbatim
 * text) next to a canonicalized value when a field opts into `keep_raw`. In the
 * UI we don't want those as separate rows — we suppress the standalone `_raw`
 * key and surface its value as dimmed secondary text under the canonical value.
 */

const RAW_SUFFIX = "_raw";

export interface KeepRawView {
  /** Entries to render, with suppressed `<field>_raw` companions removed. */
  entries: [string, unknown][];
  /** Verbatim companion value keyed by its base field name. */
  rawByField: Record<string, string>;
}

/**
 * Split an extracted object into the entries to display and a map of base field
 * → verbatim companion. A `<field>_raw` key is suppressed only when its base
 * `<field>` also exists and the companion is a non-empty value; otherwise it is
 * left in `entries` to render normally (so we never hide real data).
 */
export function keepRawView(obj: unknown): KeepRawView {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { entries: [], rawByField: {} };
  }
  const record = obj as Record<string, unknown>;
  const rawByField: Record<string, string> = {};
  const suppressed = new Set<string>();

  for (const [key, value] of Object.entries(record)) {
    if (!key.endsWith(RAW_SUFFIX)) continue;
    const base = key.slice(0, -RAW_SUFFIX.length);
    if (base && base in record && value != null && String(value) !== "") {
      rawByField[base] = String(value);
      suppressed.add(key);
    }
  }

  return {
    entries: Object.entries(record).filter(([k]) => !suppressed.has(k)),
    rawByField,
  };
}
