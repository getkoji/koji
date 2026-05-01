import type { RawPipelineDefinition, RawStep, RawEdge } from './types.js';

/**
 * Expand syntactic sugar in a raw pipeline definition into explicit
 * steps + edges arrays.  Three sugar forms are handled:
 *
 * 1. **Single-schema shorthand** — `schema` (+ optional `webhook`) at the top
 *    level expands into an `extract` step and optionally a `webhook` step.
 *
 * 2. **`then` on a step** — expands into an unconditional edge.
 *
 * 3. **`on` on a classify step** — each key becomes a conditional edge
 *    (`output.label == '<key>'`).  The special key `_default` becomes a
 *    default edge.
 */
export function expandSugar(raw: RawPipelineDefinition): {
  steps: RawStep[];
  edges: RawEdge[];
} {
  // -------------------------------------------------------------------
  // 1. Single-schema shorthand
  // -------------------------------------------------------------------
  if (raw.schema && (!raw.steps || raw.steps.length === 0)) {
    const steps: RawStep[] = [
      {
        id: 'extract',
        type: 'extract',
        config: { schema: raw.schema },
      },
    ];
    const edges: RawEdge[] = [];

    if (raw.webhook) {
      steps.push({
        id: 'webhook',
        type: 'webhook',
        config: { url: raw.webhook },
      });
      edges.push({ from: 'extract', to: 'webhook' });
    }

    return { steps, edges };
  }

  // -------------------------------------------------------------------
  // 2 & 3. Expand `then` / `on` sugar on individual steps
  // -------------------------------------------------------------------
  const steps: RawStep[] = (raw.steps ?? []).map((s) => ({
    id: s.id,
    type: s.type,
    config: s.config,
    // Strip sugar keys — they become edges
  }));

  const edges: RawEdge[] = [...(raw.edges ?? [])];

  for (const step of raw.steps ?? []) {
    // `then` → unconditional edge
    if (step.then) {
      edges.push({ from: step.id, to: step.then });
    }

    // `on` → conditional edges per label
    if (step.on) {
      for (const [label, targetStepId] of Object.entries(step.on)) {
        if (label === '_default') {
          edges.push({ from: step.id, to: targetStepId, default: true });
        } else {
          edges.push({
            from: step.id,
            to: targetStepId,
            when: `output.label == '${label}'`,
          });
        }
      }
    }
  }

  return { steps, edges };
}
