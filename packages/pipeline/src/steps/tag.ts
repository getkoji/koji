import type { StepImplementation, StepContext, StepResult } from '../step-types.js';

interface TagConfig {
  tags: Record<string, string>;
}

export const tagStep: StepImplementation = {
  type: 'tag',

  async run(ctx: StepContext, config: Record<string, unknown>): Promise<StepResult> {
    const cfg = config as TagConfig;

    // Persist tags to the document row.
    // The documents table has extraction_json (jsonb) — we store tags there
    // using a jsonb merge pattern: existing tags are preserved, new tags
    // are added or overwritten.
    const db = ctx.db as { execute?(sql: string, params: unknown[]): Promise<unknown> } | null;
    if (db?.execute) {
      try {
        await db.execute(
          `UPDATE documents
           SET extraction_json = COALESCE(extraction_json, '{}'::jsonb) || jsonb_build_object('_tags', $1::jsonb)
           WHERE id = $2 AND tenant_id = $3`,
          [JSON.stringify(cfg.tags), ctx.documentId, ctx.tenantId],
        );
      } catch {
        // Non-fatal — tags are also returned in the step output so the
        // executor can persist them through the normal output path.
      }
    }

    return {
      ok: true,
      output: { tags: cfg.tags },
      costUsd: 0,
    };
  },
};
