import type { RawStep, RawEdge, PipelineSettings, ValidationError } from './types.js';
import { STEP_TYPES, DEFAULT_SETTINGS } from './types.js';
import { parseCondition, ConditionParseError } from './condition.js';

/**
 * Validate an expanded (post-sugar) pipeline definition.
 *
 * Returns an array of `ValidationError` objects.  Empty array = valid.
 */
export function validatePipeline(
  steps: RawStep[],
  edges: RawEdge[],
  settings?: PipelineSettings,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const stepIds = new Set<string>();
  const validStepTypes = new Set<string>(STEP_TYPES);

  // -- Empty pipeline -------------------------------------------------------
  if (steps.length === 0) {
    errors.push({ code: 'EMPTY_PIPELINE', message: 'Pipeline must have at least one step.' });
    return errors;
  }

  // -- Step ID uniqueness (7) -----------------------------------------------
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      errors.push({
        code: 'DUPLICATE_STEP_ID',
        message: `Duplicate step id '${step.id}'.`,
        stepId: step.id,
      });
    }
    stepIds.add(step.id);
  }

  // -- Step type valid (10) -------------------------------------------------
  for (const step of steps) {
    if (!validStepTypes.has(step.type)) {
      errors.push({
        code: 'INVALID_STEP_TYPE',
        message: `Step '${step.id}' has unknown type '${step.type}'.`,
        stepId: step.id,
      });
    }
  }

  // -- Max steps (9) --------------------------------------------------------
  if (steps.length > merged.max_steps) {
    errors.push({
      code: 'MAX_STEPS_EXCEEDED',
      message: `Pipeline has ${steps.length} steps, max is ${merged.max_steps}.`,
    });
  }

  // -- Edge targets / sources exist (4, 5) ----------------------------------
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    if (!stepIds.has(edge.from)) {
      errors.push({
        code: 'EDGE_SOURCE_NOT_FOUND',
        message: `Edge ${i}: source step '${edge.from}' does not exist.`,
        edgeIndex: i,
      });
    }
    if (!stepIds.has(edge.to)) {
      errors.push({
        code: 'EDGE_TARGET_NOT_FOUND',
        message: `Edge ${i}: target step '${edge.to}' does not exist.`,
        edgeIndex: i,
      });
    }
  }

  // -- Build adjacency structures -------------------------------------------
  const incomingCount = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const id of stepIds) {
    incomingCount.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (stepIds.has(edge.from) && stepIds.has(edge.to)) {
      outgoing.get(edge.from)!.push(edge.to);
      incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    }
  }

  // -- Single entry point (2) -----------------------------------------------
  const entrySteps = [...stepIds].filter((id) => incomingCount.get(id) === 0);
  if (entrySteps.length === 0) {
    errors.push({
      code: 'NO_ENTRY_POINT',
      message: 'No entry step found (every step has incoming edges — likely a cycle).',
    });
  } else if (entrySteps.length > 1) {
    errors.push({
      code: 'MULTIPLE_ENTRY_POINTS',
      message: `Multiple entry steps found: ${entrySteps.join(', ')}. Pipeline must have exactly one.`,
    });
  }

  // -- Edge completeness (6) ------------------------------------------------
  const terminalSteps = [...stepIds].filter((id) => (outgoing.get(id)?.length ?? 0) === 0);
  const terminalSet = new Set(terminalSteps);
  for (const id of stepIds) {
    if (!terminalSet.has(id) && (outgoing.get(id)?.length ?? 0) === 0) {
      // This shouldn't differ from terminalSet but kept for safety
      errors.push({
        code: 'NO_OUTGOING_EDGE',
        message: `Step '${id}' has no outgoing edges and is not a terminal step.`,
        stepId: id,
      });
    }
  }

  // -- No cycles (1) — Kahn's algorithm ------------------------------------
  {
    const inDeg = new Map<string, number>();
    for (const [id, count] of incomingCount) inDeg.set(id, count);

    const queue = [...stepIds].filter((id) => inDeg.get(id) === 0);
    let visited = 0;

    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      for (const neighbor of outgoing.get(node) ?? []) {
        const newDeg = (inDeg.get(neighbor) ?? 1) - 1;
        inDeg.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (visited < stepIds.size) {
      // Find the nodes still in the cycle for a helpful message
      const inCycle = [...stepIds].filter((id) => (inDeg.get(id) ?? 0) > 0);
      errors.push({
        code: 'CYCLE_DETECTED',
        message: `Cycle detected involving steps: ${inCycle.join(', ')}.`,
      });
    }
  }

  // -- All steps reachable (3) ----------------------------------------------
  if (entrySteps.length === 1) {
    const reachable = new Set<string>();
    const queue = [entrySteps[0]!];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (reachable.has(node)) continue;
      reachable.add(node);
      for (const neighbor of outgoing.get(node) ?? []) {
        if (!reachable.has(neighbor)) queue.push(neighbor);
      }
    }
    for (const id of stepIds) {
      if (!reachable.has(id)) {
        errors.push({
          code: 'UNREACHABLE_STEP',
          message: `Step '${id}' is not reachable from the entry step.`,
          stepId: id,
        });
      }
    }
  }

  // -- Condition syntax (8) -------------------------------------------------
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    if (edge.when) {
      try {
        parseCondition(edge.when);
      } catch (err) {
        const msg = err instanceof ConditionParseError ? err.message : String(err);
        errors.push({
          code: 'INVALID_CONDITION',
          message: `Edge ${i}: invalid condition — ${msg}`,
          edgeIndex: i,
        });
      }
    }
  }

  return errors;
}
