/**
 * Classifier config artifact — the user-authored definition of what classes
 * exist and how much to spend deciding between them.
 *
 * This is the schema-sibling artifact: the same YAML → versioned → CRUD shape
 * as an extraction schema, with a `classes` list instead of `fields` and a
 * `classify` block holding the cost controls the user owns. The engine reads
 * a normalized config; it never hardcodes a class.
 */

import { parse as parseYaml } from "yaml";
import { UNKNOWN_LABEL } from "./types";
import type { TierValue } from "./types";

export type ScanStrategy = "head" | "head_and_tail";
export type OnUnknown = "return" | "reject";

/** One user-defined class the classifier can assign. */
export interface ClassifierClass {
  /** Stable label returned when this class wins (e.g. "invoice"). */
  id: string;
  /** Human description; also fed to the LLM tier as the class definition. */
  description?: string;
  /** Deterministic keyword signals (Tier 2). Case-insensitive. */
  keywords?: string[];
  /** Deterministic regex signals (Tier 2). Compiled case-insensitive. */
  patterns?: string[];
  /** Per-class page-window override — the cost dial for this class. */
  window?: number;
}

/** Fully-normalized classifier config with all defaults applied. */
export interface ClassifierConfig {
  name?: string;
  description?: string;
  /** Default leading pages to consider. */
  window: number;
  /** Where the window samples from. */
  scan: ScanStrategy;
  /** Cost ceiling: the cascade never spends past this tier. */
  maxTier: TierValue;
  /** Whether an unmatched document returns "unknown" or is rejected. */
  onUnknown: OnUnknown;
  /**
   * Minimum deterministic score for a Tier-2 keyword match to win outright,
   * and the margin it must beat the runner-up by. Ambiguous ties escalate to
   * the LLM tier rather than guess.
   */
  keywordThreshold: number;
  keywordMargin: number;
  classes: ClassifierClass[];
}

export const DEFAULTS = {
  window: 3,
  scan: "head" as ScanStrategy,
  maxTier: 4 as TierValue,
  onUnknown: "return" as OnUnknown,
  keywordThreshold: 0.6,
  keywordMargin: 0.15,
};

export class ClassifierConfigError extends Error {}

function asStringArray(v: unknown, ctx: string): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ClassifierConfigError(`${ctx} must be an array of strings`);
  }
  return v as string[];
}

function asWindow(v: unknown, ctx: string): number | undefined {
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new ClassifierConfigError(`${ctx} must be an integer >= 1`);
  }
  return v;
}

/**
 * Validate + fill defaults on a raw config object (already parsed from
 * YAML/JSON). Throws {@link ClassifierConfigError} on invalid input.
 */
export function normalizeConfig(raw: unknown): ClassifierConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClassifierConfigError("classifier config must be an object");
  }
  const obj = raw as Record<string, unknown>;

  // The cost controls live under an optional `classify` block; tolerate them at
  // the top level too so ad-hoc/inline callers don't need the nesting.
  const controls = (
    typeof obj.classify === "object" && obj.classify !== null ? obj.classify : obj
  ) as Record<string, unknown>;

  const rawClasses = obj.classes;
  if (typeof rawClasses !== "object" || rawClasses === null) {
    throw new ClassifierConfigError("config must declare `classes`");
  }

  // Accept both a list of {id,...} and a map of id → {...} (mirrors how the
  // extraction schema expresses `fields` as a map).
  const classEntries: Array<[string, Record<string, unknown>]> = Array.isArray(rawClasses)
    ? rawClasses.map((c, i) => {
        if (typeof c !== "object" || c === null) {
          throw new ClassifierConfigError(`classes[${i}] must be an object`);
        }
        const rec = c as Record<string, unknown>;
        const id = rec.id;
        if (typeof id !== "string" || !id.trim()) {
          throw new ClassifierConfigError(`classes[${i}] is missing a string \`id\``);
        }
        return [id.trim(), rec];
      })
    : Object.entries(rawClasses as Record<string, unknown>).map(([id, c]) => {
        if (typeof c !== "object" || c === null) {
          throw new ClassifierConfigError(`class "${id}" must be an object`);
        }
        return [id, c as Record<string, unknown>];
      });

  if (classEntries.length === 0) {
    throw new ClassifierConfigError("config must declare at least one class");
  }

  const seen = new Set<string>();
  const classes: ClassifierClass[] = classEntries.map(([id, rec]) => {
    if (id === UNKNOWN_LABEL) {
      throw new ClassifierConfigError(`"${UNKNOWN_LABEL}" is reserved and cannot be a class id`);
    }
    if (seen.has(id)) {
      throw new ClassifierConfigError(`duplicate class id "${id}"`);
    }
    seen.add(id);

    const description = typeof rec.description === "string" ? rec.description : undefined;
    const keywords = asStringArray(rec.keywords, `class "${id}" keywords`);
    const patterns = asStringArray(rec.patterns, `class "${id}" patterns`);
    // Compile patterns eagerly so a bad regex fails at config time, not runtime.
    for (const p of patterns ?? []) {
      try {
        new RegExp(p, "i");
      } catch {
        throw new ClassifierConfigError(`class "${id}" has an invalid pattern: ${p}`);
      }
    }
    return {
      id,
      description,
      keywords,
      patterns,
      window: asWindow(rec.window, `class "${id}" window`),
    };
  });

  const scanRaw = controls.scan ?? DEFAULTS.scan;
  if (scanRaw !== "head" && scanRaw !== "head_and_tail") {
    throw new ClassifierConfigError(`scan must be "head" or "head_and_tail"`);
  }

  const onUnknownRaw = controls.on_unknown ?? controls.onUnknown ?? DEFAULTS.onUnknown;
  if (onUnknownRaw !== "return" && onUnknownRaw !== "reject") {
    throw new ClassifierConfigError(`on_unknown must be "return" or "reject"`);
  }

  const maxTierRaw = controls.max_tier ?? controls.maxTier ?? DEFAULTS.maxTier;
  if (
    typeof maxTierRaw !== "number" ||
    !Number.isInteger(maxTierRaw) ||
    maxTierRaw < 0 ||
    maxTierRaw > 4
  ) {
    throw new ClassifierConfigError("max_tier must be an integer in 0..4");
  }

  const threshold = numberOr(controls.keyword_threshold ?? controls.keywordThreshold, DEFAULTS.keywordThreshold, "keyword_threshold", 0, 1);
  const margin = numberOr(controls.keyword_margin ?? controls.keywordMargin, DEFAULTS.keywordMargin, "keyword_margin", 0, 1);

  return {
    name: typeof obj.name === "string" ? obj.name : undefined,
    description: typeof obj.description === "string" ? obj.description : undefined,
    window: asWindow(controls.window, "window") ?? DEFAULTS.window,
    scan: scanRaw,
    maxTier: maxTierRaw as TierValue,
    onUnknown: onUnknownRaw,
    keywordThreshold: threshold,
    keywordMargin: margin,
    classes,
  };
}

function numberOr(v: unknown, fallback: number, ctx: string, min: number, max: number): number {
  if (v == null) return fallback;
  if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
    throw new ClassifierConfigError(`${ctx} must be a number in ${min}..${max}`);
  }
  return v;
}

/** Parse a classifier config from YAML source and normalize it. */
export function parseClassifierYaml(src: string): ClassifierConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(src);
  } catch (err) {
    throw new ClassifierConfigError(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return normalizeConfig(parsed);
}
