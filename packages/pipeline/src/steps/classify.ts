import type { StepImplementation } from './types';

/**
 * Classify step — routes documents based on content type or category.
 *
 * Placeholder: real implementation will call a classification model
 * with keyword-first matching and LLM fallback.
 */
export const classifyStep: StepImplementation = {
  type: 'classify',
  async run(_ctx, _config) {
    // TODO: Wire to classification model endpoint (keyword + LLM)
    return {
      ok: true,
      output: {},
      costUsd: 0.02,
    };
  },
};
