import type { StepImplementation, StepContext, StepResult } from '../step-types.js';

interface FilterConfig {
  condition: string;
  on_fail: 'stop' | 'tag' | 'fail';
  on_fail_tags?: Record<string, string>;
}

export const filterStep: StepImplementation = {
  type: 'filter',

  async run(ctx: StepContext, config: Record<string, unknown>): Promise<StepResult> {
    const cfg = config as FilterConfig;

    // Build evaluation context from document metadata and upstream step outputs
    const evalContext: Record<string, unknown> = {
      document: {
        filename: ctx.document.filename,
        mime_type: ctx.document.mimeType,
        page_count: ctx.document.pageCount,
        content_hash: ctx.document.contentHash,
      },
      steps: Object.fromEntries(
        Object.entries(ctx.stepOutputs).map(([id, o]) => [id, { output: o.output }]),
      ),
    };

    // Evaluate condition against context
    const passed = evaluateSimpleCondition(cfg.condition, evalContext);

    if (passed) {
      return {
        ok: true,
        output: { passed: true },
        costUsd: 0,
      };
    }

    // Condition failed — apply on_fail action
    switch (cfg.on_fail) {
      case 'fail':
        return {
          ok: false,
          output: { passed: false },
          costUsd: 0,
          error: `Filter condition failed: ${cfg.condition}`,
        };

      case 'tag':
        return {
          ok: true,
          output: {
            passed: false,
            tags: cfg.on_fail_tags ?? { filter_failed: cfg.condition },
          },
          costUsd: 0,
        };

      case 'stop':
      default:
        return {
          ok: true,
          output: { passed: false, stopped: true },
          costUsd: 0,
        };
    }
  },
};

// ---------------------------------------------------------------------------
// Simple condition evaluator
// ---------------------------------------------------------------------------

/**
 * Simple condition evaluator for filter expressions.
 * Supports: field.path > N, field.path == 'value', field.path != 'value',
 *           field.path >= N, field.path <= N, field.path < N
 *
 * This is intentionally simpler than the full pipeline condition parser
 * (which handles AND/OR/IN/contains etc.) — filter conditions are typically
 * simple guards like "document.page_count > 1".
 *
 * When the full condition parser from @koji/pipeline is available,
 * this should delegate to it instead.
 */
export function evaluateSimpleCondition(
  condition: string,
  context: Record<string, unknown>,
): boolean {
  // Try to parse as: left op right
  const match = condition.match(/^([\w.]+)\s*(==|!=|>=?|<=?)\s*(.+)$/);

  if (!match) return true; // unparseable conditions pass by default

  const [, path, op, rawRight] = match;

  // Resolve left side from context
  const left = resolvePath(context, path!);

  // Parse right side
  const right = parseValue(rawRight!.trim());

  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return (left as number) > (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '<':
      return (left as number) < (right as number);
    case '<=':
      return (left as number) <= (right as number);
    default:
      return true;
  }
}

function parseValue(raw: string): unknown {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;

  const num = Number(raw);
  if (!isNaN(num)) return num;

  return raw;
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
