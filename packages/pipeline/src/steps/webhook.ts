import type { StepImplementation } from './types';

/**
 * Webhook step — sends pipeline data to an external HTTP endpoint.
 *
 * Placeholder: real implementation will POST to the configured URL.
 */
export const webhookStep: StepImplementation = {
  type: 'webhook',
  async run(_ctx, _config) {
    // TODO: POST to configured webhook URL with step outputs
    return {
      ok: true,
      output: {},
      costUsd: 0,
    };
  },
};
