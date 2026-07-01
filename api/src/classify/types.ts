/**
 * Shared runtime types for the document classifier.
 *
 * The classifier answers "which of a user-defined set of classes is this
 * document?" via a cost cascade: cheap deterministic signals first, paid model
 * calls only for the hard tail. See ./cascade.ts for the orchestration and
 * docs/document-classifier.md (playbook) for the design.
 *
 * Nothing here is domain-specific — classes, keywords, and patterns are all
 * user configuration (see ./config.ts). The engine ships zero built-in classes.
 */

/** Label returned when no class is confidently matched. */
export const UNKNOWN_LABEL = "unknown";

/**
 * Cost tiers, cheapest to most expensive. `tierUsed` on an outcome names the
 * tier that produced the label (or the deepest tier reached, when unknown).
 *
 * - METADATA (0): mime / extension / page count — routing only, never labels.
 * - TEXT (1): cheap text-layer probe over the page window (no OCR).
 * - KEYWORD (2): deterministic keyword/pattern match on that text.
 * - LLM (3): model classify over the windowed text.
 * - VISION (4): model classify over rendered page images (scanned tail).
 */
export const Tier = {
  METADATA: 0,
  TEXT: 1,
  KEYWORD: 2,
  LLM: 3,
  VISION: 4,
} as const;

export type TierValue = (typeof Tier)[keyof typeof Tier];

export type ClassifyMethod = "metadata" | "keyword" | "llm" | "vision" | "unknown";

/** Text extracted from a single page, carrying its real 1-based page number. */
export interface PageText {
  /** 1-based page number in the source document. */
  page: number;
  /** Extracted text for the page (may be empty for scanned/blank pages). */
  text: string;
}

/** Deterministic match score for one class against the windowed text. */
export interface ClassScore {
  id: string;
  /** Fraction of the class's keyword+pattern signals that matched (0..1). */
  score: number;
  /** Number of signals matched. */
  hits: number;
  /** Total number of signals the class declared (keywords + patterns). */
  total: number;
  /** Page (1-based) that contributed the most matches, or null if none. */
  evidencePage: number | null;
}

/** Result of running the cascade on a single document. */
export interface ClassifyOutcome {
  /** Winning class id, or {@link UNKNOWN_LABEL}. */
  label: string;
  /** Confidence in the label (0..1). Semantics vary by method — see method. */
  confidence: number;
  /** Which tier produced the label. */
  method: ClassifyMethod;
  /** Numeric tier that produced the label, or deepest tier reached if unknown. */
  tierUsed: TierValue;
  /** Page (1-based) the label was keyed on, when known. */
  evidencePage: number | null;
  /** Per-class deterministic scores (present when the keyword tier ran). */
  scores?: ClassScore[];
}
