/**
 * Condition evaluator for pipeline edge routing.
 *
 * Evaluates a ParsedCondition against a context object to determine which
 * outgoing edge to follow from a step.
 */

import type { ParsedCondition } from './types';

/**
 * Resolve a dotted field path (e.g. "output.category") against a context object.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a single parsed condition against a context object.
 *
 * The context typically contains:
 * - `output` — the output of the current step
 * - `document` — document metadata
 * - `steps` — map of stepId -> { output }
 */
export function evaluateCondition(
  condition: ParsedCondition,
  context: Record<string, unknown>,
): boolean {
  const actual = resolvePath(context, condition.field);
  const expected = condition.value;

  switch (condition.op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'matches':
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    default:
      return false;
  }
}
