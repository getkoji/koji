import type { StepImplementation } from './types';

/**
 * Filter step — conditionally drops documents from the pipeline.
 *
 * Placeholder: real implementation will evaluate filter rules.
 */
export const filterStep: StepImplementation = {
  type: 'filter',
  async run(_ctx, _config) {
    // TODO: Evaluate filter rules against document metadata/content
    return {
      ok: true,
      output: {},
      costUsd: 0,
    };
  },
};
