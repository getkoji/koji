import type { StepType } from '../types';

export interface StepContext {
  tenantId: string;
  documentId: string;
  jobId: string;
  /** Document info */
  document: {
    filename: string;
    storageKey: string;
    mimeType: string;
    pageCount?: number;
    contentHash: string;
  };
  /** Accumulated outputs from upstream steps */
  stepOutputs: Record<string, StepOutput>;
  /** Dependencies (injected by executor) */
  db: unknown;
  storage: unknown;
  endpoints: unknown;
  queue: unknown;
}

export interface StepOutput {
  stepId: string;
  stepType: StepType;
  output: Record<string, unknown>;
  durationMs: number;
  costUsd: number;
}

export interface StepResult {
  ok: boolean;
  output: Record<string, unknown>;
  costUsd: number;
  error?: string;
  retryable?: boolean;
}

export interface StepImplementation {
  type: StepType;
  run(ctx: StepContext, config: Record<string, unknown>): Promise<StepResult>;
}
