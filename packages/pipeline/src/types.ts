// Step types supported by the pipeline
export type StepType =
  | 'classify' | 'extract' | 'ocr' | 'split'
  | 'tag' | 'filter' | 'webhook' | 'transform' | 'gate'
  | 'redact' | 'enrich' | 'validate' | 'summarize'
  | 'compare' | 'merge_documents' | 'resolve_references';

export const STEP_TYPES: readonly StepType[] = [
  'classify', 'extract', 'ocr', 'split',
  'tag', 'filter', 'webhook', 'transform', 'gate',
  'redact', 'enrich', 'validate', 'summarize',
  'compare', 'merge_documents', 'resolve_references',
] as const;

// Per-step platform cost (USD per doc).
//
// This is the ONE table. It is `Record<StepType, number>` on purpose: adding a
// StepType without pricing it is a compile error, which is what keeps the number
// in the estimate equal to the number the runners report. Both the DAG runner
// and the pipeline test endpoint used to keep private `Record<string, number>`
// copies, and all three drifted — production was missing every step from
// `redact` down, so a pipeline was estimated at one price and reported another
// (oss-518). Read it through `stepCost()`, never by indexing a raw string.
export const STEP_COSTS: Record<StepType, number> = {
  classify: 0.005,
  extract: 0.08,
  ocr: 0.03,
  split: 0.01,
  tag: 0,
  filter: 0,
  webhook: 0,
  transform: 0,
  gate: 0,
  redact: 0.005,
  enrich: 0,
  validate: 0,
  summarize: 0.01,
  compare: 0.005,
  merge_documents: 0,
  resolve_references: 0.02,
};

/**
 * Price for a step type, or 0 for one this build doesn't know.
 *
 * Callers hold a step type as a plain `string` (it arrives from user YAML), so
 * they cannot index `STEP_COSTS` directly. This is the sanctioned lookup — it
 * keeps the unknown-type fallback in one place instead of a `?? 0` at each
 * call site that silently hid missing entries.
 */
export function stepCost(type: string): number {
  // hasOwnProperty, not `?? 0`: a step type read from user YAML can collide with
  // an inherited Object member ("constructor", "toString"), and those resolve to
  // functions rather than undefined — which `?? 0` passes straight through into
  // a summed cost total as NaN.
  const table = STEP_COSTS as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(table, type)) return 0;
  const value = table[type];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Raw YAML input (what the user writes)
// ---------------------------------------------------------------------------

export interface RawPipelineDefinition {
  pipeline: string;
  version?: number;
  description?: string;
  // Single-schema shorthand
  schema?: string;
  webhook?: string;
  // Full DAG definition
  steps?: RawStep[];
  edges?: RawEdge[];
  settings?: PipelineSettings;
}

export interface RawStep {
  id: string;
  type: StepType;
  config?: Record<string, unknown>;
  then?: string;                      // sugar: unconditional edge to next step
  on?: Record<string, string>;        // sugar: label → step_id mapping
}

export interface RawEdge {
  from: string;
  to: string;
  when?: string;
  default?: boolean;
}

export interface PipelineSettings {
  on_no_match?: 'fail' | 'tag_unrouted' | 'stop';
  max_steps?: number;
  timeout_seconds?: number;
}

// ---------------------------------------------------------------------------
// Compiled output (what the executor runs)
// ---------------------------------------------------------------------------

export interface CompiledPipeline {
  name: string;
  version: number;
  description?: string;
  steps: CompiledStep[];
  edges: CompiledEdge[];
  entryStepId: string;
  terminalStepIds: string[];
  estimatedMaxCostPerDoc: number;
  settings: Required<PipelineSettings>;
}

export interface CompiledStep {
  id: string;
  type: StepType;
  config: Record<string, unknown>;
  costPerDoc: number;
}

export interface CompiledEdge {
  from: string;
  to: string;
  condition: ParsedCondition | null;
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Condition AST
// ---------------------------------------------------------------------------

export type ParsedCondition =
  | { type: 'comparison'; left: ConditionRef; op: ComparisonOp; right: ConditionValue }
  | { type: 'membership'; left: ConditionRef; op: 'in' | 'not_in'; right: ConditionValue[] }
  | { type: 'contains'; left: ConditionRef; right: string }
  | { type: 'and'; left: ParsedCondition; right: ParsedCondition }
  | { type: 'or'; left: ParsedCondition; right: ParsedCondition }
  | { type: 'not'; operand: ParsedCondition };

export type ComparisonOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

export type ConditionRef = {
  type: 'ref';
  path: string[];
};

export type ConditionValue = string | number | boolean | null;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  code: string;
  message: string;
  stepId?: string;
  edgeIndex?: number;
}

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Required<PipelineSettings> = {
  on_no_match: 'fail',
  max_steps: 20,
  timeout_seconds: 300,
};
