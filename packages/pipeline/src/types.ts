/**
 * Core pipeline types — shared between the compiler and executor.
 *
 * The compiler (PR #197) parses YAML into these structures. The executor walks
 * the CompiledPipeline DAG at runtime.
 */

// -- Step types supported by the pipeline engine --

export const StepTypes = [
  'extract',
  'classify',
  'tag',
  'filter',
  'webhook',
  'transform',
] as const;

export type StepType = (typeof StepTypes)[number];

// -- Compiled pipeline structures --

export interface CompiledStep {
  id: string;
  type: StepType;
  config: Record<string, unknown>;
}

export interface ParsedCondition {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'matches';
  value: unknown;
}

export interface CompiledEdge {
  from: string;
  to: string;
  condition: ParsedCondition | null;
  isDefault: boolean;
}

export interface PipelineSettings {
  max_steps: number;
  timeout_ms: number;
  on_no_match: 'skip' | 'fail';
}

export interface CompiledPipeline {
  id: string;
  version: number;
  steps: CompiledStep[];
  edges: CompiledEdge[];
  entryStepId: string;
  settings: PipelineSettings;
}
