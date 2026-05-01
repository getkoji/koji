import type { StepImplementation } from './types';

/**
 * Tag step — applies metadata tags to documents.
 *
 * Placeholder: real implementation will run tag inference.
 */
export const tagStep: StepImplementation = {
  type: 'tag',
  async run(_ctx, _config) {
    // TODO: Wire to tag inference
    return {
      ok: true,
      output: {},
      costUsd: 0.01,
    };
  },
};
