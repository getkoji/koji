import type { StepImplementation } from './types';

/**
 * Extract step — wraps the existing extraction pipeline.
 *
 * Placeholder: real implementation will call createExtractionJob and wire
 * into the existing parse → extract → normalize flow.
 */
export const extractStep: StepImplementation = {
  type: 'extract',
  async run(_ctx, config) {
    // TODO: Wire to existing extraction pipeline (createExtractionJob)
    // For now, return a marker that tells the executor to delegate to the legacy extraction path
    return {
      ok: true,
      output: { _delegate: 'extraction_pipeline', schema: config.schema },
      costUsd: 0.08,
    };
  },
};
