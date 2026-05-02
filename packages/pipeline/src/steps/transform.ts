import type { StepImplementation, StepContext } from './types';

interface TransformConfig {
  operations: TransformOperation[];
}

type TransformOperation =
  | { rename: { from: string; to: string } }
  | { set: { field: string; value: unknown } }
  | { remove: { field: string } }
  | { copy: { from: string; to: string } }
  | { lowercase: { field: string } }
  | { uppercase: { field: string } }
  | { trim: { field: string } }
  | { template: { field: string; value: string } };

/**
 * Transform step — applies field-level transformations to upstream outputs.
 *
 * Collects all upstream outputs that have `fields`, merges them, then applies
 * each operation in order: rename, set, remove, copy, lowercase, uppercase,
 * trim, template.
 */
export const transformStep: StepImplementation = {
  type: 'transform',
  async run(ctx, config) {
    const cfg = config as TransformConfig;

    if (!cfg.operations || !Array.isArray(cfg.operations)) {
      return { ok: true, output: {}, costUsd: 0 };
    }

    // Start with merged fields from upstream steps
    let result: Record<string, unknown> = {};
    for (const stepOutput of Object.values(ctx.stepOutputs)) {
      if (stepOutput.output?.fields && typeof stepOutput.output.fields === 'object') {
        result = { ...result, ...(stepOutput.output.fields as Record<string, unknown>) };
      }
    }

    // Apply operations in order
    const applied: string[] = [];

    for (const op of cfg.operations) {
      if ('rename' in op) {
        const { from, to } = op.rename;
        if (from in result) {
          result[to] = result[from];
          delete result[from];
          applied.push(`rename: ${from} -> ${to}`);
        }
      } else if ('set' in op) {
        const { field, value } = op.set;
        result[field] = resolveSetValue(value, ctx);
        applied.push(`set: ${field}`);
      } else if ('remove' in op) {
        const { field } = op.remove;
        delete result[field];
        applied.push(`remove: ${field}`);
      } else if ('copy' in op) {
        const { from, to } = op.copy;
        if (from in result) {
          result[to] = result[from];
          applied.push(`copy: ${from} -> ${to}`);
        }
      } else if ('lowercase' in op) {
        const { field } = op.lowercase;
        if (typeof result[field] === 'string') {
          result[field] = (result[field] as string).toLowerCase();
          applied.push(`lowercase: ${field}`);
        }
      } else if ('uppercase' in op) {
        const { field } = op.uppercase;
        if (typeof result[field] === 'string') {
          result[field] = (result[field] as string).toUpperCase();
          applied.push(`uppercase: ${field}`);
        }
      } else if ('trim' in op) {
        const { field } = op.trim;
        if (typeof result[field] === 'string') {
          result[field] = (result[field] as string).trim();
          applied.push(`trim: ${field}`);
        }
      } else if ('template' in op) {
        const { field, value: tmpl } = op.template;
        let rendered = tmpl;
        for (const [k, v] of Object.entries(result)) {
          rendered = rendered.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? ''));
        }
        result[field] = rendered;
        applied.push(`template: ${field}`);
      }
    }

    return {
      ok: true,
      output: {
        fields: result,
        operations_applied: applied,
        operation_count: applied.length,
      },
      costUsd: 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve template variables in `set` values (e.g. {{now}}, {{document.filename}}). */
function resolveSetValue(value: unknown, ctx: StepContext): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\{\{now\}\}/g, new Date().toISOString())
    .replace(/\{\{document\.filename\}\}/g, ctx.document.filename)
    .replace(/\{\{document\.mime_type\}\}/g, ctx.document.mimeType)
    .replace(/\{\{document_id\}\}/g, ctx.documentId)
    .replace(/\{\{job_id\}\}/g, ctx.jobId)
    .replace(/\{\{tenant_id\}\}/g, ctx.tenantId);
}
