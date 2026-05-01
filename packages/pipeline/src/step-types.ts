/**
 * Step execution interfaces for pipeline step implementations.
 *
 * These types define the contract between the DAG executor and individual
 * step implementations. When the full @koji/pipeline types package is
 * available, these should be imported from there instead.
 */

export interface StepImplementation {
  type: string;
  run(ctx: StepContext, config: Record<string, unknown>): Promise<StepResult>;
}

export interface StepContext {
  tenantId: string;
  documentId: string;
  jobId: string;
  document: {
    filename: string;
    storageKey: string;
    mimeType: string;
    pageCount?: number;
    contentHash: string;
  };
  stepOutputs: Record<string, { output: Record<string, unknown> }>;
  db: unknown;
  storage: unknown;
  endpoints: unknown;
  queue: unknown;
}

export interface StepResult {
  ok: boolean;
  output: Record<string, unknown>;
  costUsd: number;
  error?: string;
}
