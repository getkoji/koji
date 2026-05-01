import YAML from 'yaml';
import type {
  RawPipelineDefinition,
  CompiledPipeline,
  CompiledStep,
  CompiledEdge,
  ValidationError,
} from './types.js';
import { STEP_COSTS, DEFAULT_SETTINGS } from './types.js';
import { expandSugar } from './sugar.js';
import { validatePipeline } from './validate.js';
import { parseCondition } from './condition.js';
import { calculatePipelineCosts } from './cost.js';

export type CompileResult =
  | { ok: true; pipeline: CompiledPipeline }
  | { ok: false; errors: ValidationError[] };

/**
 * Compile a pipeline YAML string into a validated, executable
 * `CompiledPipeline` — or return structured validation errors.
 */
export function compilePipeline(yamlSource: string): CompileResult {
  // 1. Parse YAML -------------------------------------------------------
  let raw: RawPipelineDefinition;
  try {
    raw = YAML.parse(yamlSource) as RawPipelineDefinition;
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: 'YAML_PARSE_ERROR',
          message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  if (!raw || typeof raw !== 'object' || !raw.pipeline) {
    return {
      ok: false,
      errors: [{ code: 'MISSING_PIPELINE_NAME', message: 'Top-level `pipeline` key is required.' }],
    };
  }

  // 2. Expand sugar -------------------------------------------------------
  const { steps, edges } = expandSugar(raw);

  // 3. Validate -----------------------------------------------------------
  const settings = { ...DEFAULT_SETTINGS, ...raw.settings };
  const errors = validatePipeline(steps, edges, settings);

  // 4. If errors, return them ---------------------------------------------
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 5. Build compiled pipeline --------------------------------------------

  // Build step map
  const compiledSteps: CompiledStep[] = steps.map((s) => ({
    id: s.id,
    type: s.type,
    config: s.config ?? {},
    costPerDoc: STEP_COSTS[s.type] ?? 0,
  }));

  // Build edge map with parsed conditions
  const compiledEdges: CompiledEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    condition: e.when ? parseCondition(e.when) : null,
    isDefault: e.default ?? false,
  }));

  // Identify entry step (no incoming edges)
  const incomingSteps = new Set(compiledEdges.map((e) => e.to));
  const entryStep = compiledSteps.find((s) => !incomingSteps.has(s.id));

  // Identify terminal steps (no outgoing edges)
  const outgoingSteps = new Set(compiledEdges.map((e) => e.from));
  const terminalStepIds = compiledSteps
    .filter((s) => !outgoingSteps.has(s.id))
    .map((s) => s.id);

  const pipeline: CompiledPipeline = {
    name: raw.pipeline,
    version: raw.version ?? 1,
    description: raw.description,
    steps: compiledSteps,
    edges: compiledEdges,
    entryStepId: entryStep!.id,
    terminalStepIds,
    estimatedMaxCostPerDoc: 0, // computed below
    settings,
  };

  // 6. Compute max path cost ----------------------------------------------
  const { maxCostPerDoc } = calculatePipelineCosts(pipeline);
  pipeline.estimatedMaxCostPerDoc = maxCostPerDoc;

  return { ok: true, pipeline };
}
