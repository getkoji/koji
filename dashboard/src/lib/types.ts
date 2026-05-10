/**
 * Shared types for dashboard components.
 * These will be replaced by @koji/types imports once the API endpoints
 * land for traces, extraction results, etc.
 */

export interface TraceStage {
  name: string;
  /** Raw stage name before prettifying (e.g. "classify: classify_guci") */
  rawName: string;
  durationMs: number;
  startPct: number;
  widthPct: number;
  status: "ok" | "warn" | "fail";
  meta: string;
  /** Structured output from the step (outputJson for DAG, summaryJson for legacy) */
  output: Record<string, unknown> | null;
}

export interface TraceField {
  name: string;
  value: string;
  chunk: string;
  confidence: number;
  wrong?: boolean;
  diagnostic?: string;
}

export interface SchemaLine {
  num: number;
  content: string;
  added?: boolean;
}

export interface ExtractionField {
  name: string;
  value: string;
  confidence: number;
}
