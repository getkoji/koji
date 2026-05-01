import type { StepImplementation } from './types';

/**
 * Transform step — applies data transformations to step outputs.
 *
 * Placeholder: real implementation will run user-defined transformations.
 */
export const transformStep: StepImplementation = {
  type: 'transform',
  async run(_ctx, _config) {
    // TODO: Apply configured transformations to upstream step outputs
    return {
      ok: true,
      output: {},
      costUsd: 0,
    };
  },
};
