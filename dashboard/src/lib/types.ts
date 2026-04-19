/**
 * Shared types for dashboard components.
 * These will be replaced by @koji/types imports once the API endpoints
 * land for traces, extraction results, etc.
 */

export interface TraceStage {
  name: string;
  durationMs: number;
  startPct: number;
  widthPct: number;
  status: "ok" | "warn" | "fail";
  meta: string;
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
