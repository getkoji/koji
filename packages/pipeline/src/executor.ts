/**
 * Pipeline DAG executor — backend-agnostic DAG walker.
 *
 * Walks a CompiledPipeline graph step-by-step, evaluating edge conditions to
 * determine routing. Supports crash recovery by skipping already-completed
 * steps and resuming from the last checkpoint.
 */

import type { CompiledPipeline } from './types';
import { evaluateCondition } from './condition';
import { getStep } from './steps';
import type { StepContext, StepOutput } from './steps/types';

export interface ExecutorDeps {
  tenantId: string;
  documentId: string;
  jobId: string;
  document: StepContext['document'];
  db: unknown;
  storage: unknown;
  endpoints: unknown;
  queue: unknown;
  /** Called when a step begins execution. */
  onStepStart: (stepId: string, stepType: string, stepOrder: number) => Promise<void>;
  /** Called when a step completes successfully. */
  onStepComplete: (stepId: string, output: StepOutput) => Promise<void>;
  /** Called when a step fails. */
  onStepFail: (stepId: string, error: string) => Promise<void>;
  /** Retrieve already-completed steps for crash recovery. */
  getCompletedSteps: () => Promise<Record<string, StepOutput>>;
}

export interface ExecutionResult {
  status: 'completed' | 'failed';
  stepOutputs: StepOutput[];
  finalStepId: string;
  totalDurationMs: number;
  totalCostUsd: number;
  error?: string;
}

export async function executePipeline(
  pipeline: CompiledPipeline,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const stepOutputs: StepOutput[] = [];
  const outputsByStepId: Record<string, StepOutput> = {};

  // 1. Check for already-completed steps (crash recovery)
  const completed = await deps.getCompletedSteps();
  for (const [stepId, output] of Object.entries(completed)) {
    outputsByStepId[stepId] = output;
    stepOutputs.push(output);
  }

  // 2. Find starting point
  let currentStepId: string | null = pipeline.entryStepId;

  // If we have completed steps, find where to resume
  if (Object.keys(completed).length > 0) {
    const lastCompleted = stepOutputs[stepOutputs.length - 1];
    if (lastCompleted) {
      currentStepId = resolveNextStep(pipeline, lastCompleted.stepId, outputsByStepId);
      // If resolveNextStep returns null, the pipeline was already at a terminal step
      if (currentStepId === null) {
        return {
          status: 'completed',
          stepOutputs,
          finalStepId: lastCompleted.stepId,
          totalDurationMs: Date.now() - startTime,
          totalCostUsd: stepOutputs.reduce((sum, s) => sum + s.costUsd, 0),
        };
      }
    }
  }

  // 3. Walk the DAG
  let stepOrder = stepOutputs.length;
  const maxSteps = pipeline.settings.max_steps;

  while (currentStepId !== null && stepOrder < maxSteps) {
    // Skip already-completed steps
    if (outputsByStepId[currentStepId]) {
      currentStepId = resolveNextStep(pipeline, currentStepId, outputsByStepId);
      continue;
    }

    const step = pipeline.steps.find((s) => s.id === currentStepId);
    if (!step) {
      return {
        status: 'failed',
        stepOutputs,
        finalStepId: currentStepId,
        totalDurationMs: Date.now() - startTime,
        totalCostUsd: stepOutputs.reduce((sum, s) => sum + s.costUsd, 0),
        error: `Step '${currentStepId}' not found in pipeline definition`,
      };
    }

    const impl = getStep(step.type);
    if (!impl) {
      return {
        status: 'failed',
        stepOutputs,
        finalStepId: currentStepId,
        totalDurationMs: Date.now() - startTime,
        totalCostUsd: stepOutputs.reduce((sum, s) => sum + s.costUsd, 0),
        error: `No implementation registered for step type '${step.type}'`,
      };
    }

    // Notify step starting
    stepOrder++;
    await deps.onStepStart(currentStepId, step.type, stepOrder);

    // Build step context
    const ctx: StepContext = {
      tenantId: deps.tenantId,
      documentId: deps.documentId,
      jobId: deps.jobId,
      document: deps.document,
      stepOutputs: outputsByStepId,
      db: deps.db,
      storage: deps.storage,
      endpoints: deps.endpoints,
      queue: deps.queue,
    };

    // Run the step
    const stepStart = Date.now();
    let result;
    try {
      result = await impl.run(ctx, step.config);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await deps.onStepFail(currentStepId, errorMsg);
      return {
        status: 'failed',
        stepOutputs,
        finalStepId: currentStepId,
        totalDurationMs: Date.now() - startTime,
        totalCostUsd: stepOutputs.reduce((sum, s) => sum + s.costUsd, 0),
        error: `Step '${currentStepId}' threw: ${errorMsg}`,
      };
    }

    if (!result.ok) {
      await deps.onStepFail(currentStepId, result.error || 'Step failed');
      return {
        status: 'failed',
        stepOutputs,
        finalStepId: currentStepId,
        totalDurationMs: Date.now() - startTime,
        totalCostUsd: stepOutputs.reduce((sum, s) => sum + s.costUsd, 0),
        error: result.error || `Step '${currentStepId}' failed`,
      };
    }

    // Record output
    const output: StepOutput = {
      stepId: currentStepId,
      stepType: step.type,
      output: result.output,
      durationMs: Date.now() - stepStart,
      costUsd: result.costUsd,
    };

    outputsByStepId[currentStepId] = output;
    stepOutputs.push(output);
    await deps.onStepComplete(currentStepId, output);

    // Resolve next step
    currentStepId = resolveNextStep(pipeline, currentStepId, outputsByStepId);
  }

  // Determine final status
  const lastStep = stepOutputs[stepOutputs.length - 1];
  return {
    status: 'completed',
    stepOutputs,
    finalStepId: lastStep?.stepId || pipeline.entryStepId,
    totalDurationMs: Date.now() - startTime,
    totalCostUsd: stepOutputs.reduce((sum, s) => sum + s.costUsd, 0),
  };
}

/**
 * Evaluate outgoing edges from a step and return the next step ID.
 * Returns null if the step is terminal (no outgoing edges or no matching edge).
 */
function resolveNextStep(
  pipeline: CompiledPipeline,
  stepId: string,
  outputsByStepId: Record<string, StepOutput>,
): string | null {
  const outgoing = pipeline.edges.filter((e) => e.from === stepId);
  if (outgoing.length === 0) return null; // terminal step

  // Build evaluation context
  const stepOutput = outputsByStepId[stepId];
  const context: Record<string, unknown> = {
    output: stepOutput?.output || {},
    document: {},
    result: {},
    steps: Object.fromEntries(
      Object.entries(outputsByStepId).map(([id, o]) => [id, { output: o.output }]),
    ),
  };

  // Evaluate conditional edges first (in order)
  for (const edge of outgoing) {
    if (edge.isDefault) continue;
    if (edge.condition === null) return edge.to; // unconditional
    if (evaluateCondition(edge.condition, context)) return edge.to;
  }

  // Fall back to default edge
  const defaultEdge = outgoing.find((e) => e.isDefault);
  if (defaultEdge) return defaultEdge.to;

  // No edge matched
  return null;
}
