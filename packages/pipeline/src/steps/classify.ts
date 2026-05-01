/**
 * Classify step — keyword + LLM document classification.
 *
 * Mirrors the Python implementation at services/extract/classify.py:
 * keyword-first matching with optional LLM fallback. The classify step
 * returns a label that downstream branch steps use to route documents
 * through different pipeline paths.
 */

import type { StepContext, StepImplementation, StepResult } from './types';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ClassifyLabel {
  id: string;
  description?: string;
  keywords?: string[];
}

export interface ClassifyConfig {
  question: string;
  labels: ClassifyLabel[];
  method: 'keyword' | 'llm' | 'keyword_then_llm';
  llm_endpoint?: string;
  /** 'full' or 'first_n_pages(N)' */
  scope?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a scope limiter to the full document text. */
export function applyScope(text: string, scope?: string): string {
  if (!scope || scope === 'full') return text;

  const match = scope.match(/^first_n_pages\((\d+)\)$/);
  if (match) {
    const n = parseInt(match[1]!, 10);
    // Rough heuristic: ~3000 chars per page
    return text.slice(0, n * 3000);
  }

  return text;
}

/**
 * Retrieve document text from the best available source:
 *   1. A previous step's output (e.g. OCR / parse)
 *   2. Object storage (plain-text documents only)
 *   3. Filename as a minimal signal
 */
export async function getDocumentText(
  ctx: StepContext,
  scope?: string,
): Promise<string> {
  // 1. Check step outputs for text produced by an earlier step
  for (const output of Object.values(ctx.stepOutputs)) {
    if (output.output.text && typeof output.output.text === 'string') {
      return applyScope(output.output.text as string, scope);
    }
  }

  // 2. Try to read from storage
  const storage = ctx.storage as { get?: (key: string) => Promise<unknown> };
  if (storage?.get) {
    try {
      const data = await storage.get(ctx.document.storageKey);
      if (data && typeof data === 'string') {
        return applyScope(data, scope);
      }
      // Binary content (PDF etc.) — can't extract without a parse service.
      // Fall through to filename.
    } catch {
      // Storage read failed — fall through
    }
  }

  return ctx.document.filename;
}

// ---------------------------------------------------------------------------
// Keyword classification
// ---------------------------------------------------------------------------

/**
 * Classify by keyword overlap. Returns a match when 2+ keywords from a label
 * appear in the document text (case-insensitive).
 */
export function classifyByKeywords(
  text: string,
  labels: ClassifyLabel[],
): { label: string } | null {
  const lowerText = text.toLowerCase();

  for (const label of labels) {
    if (!label.keywords || label.keywords.length === 0) continue;

    const matches = label.keywords.filter((kw) =>
      lowerText.includes(kw.toLowerCase()),
    );

    // Require 2+ keyword hits to count as a match
    if (matches.length >= 2) {
      return { label: label.id };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM classification
// ---------------------------------------------------------------------------

export async function classifyWithLLM(
  ctx: StepContext,
  text: string,
  cfg: ClassifyConfig,
): Promise<{ label: string; confidence: number; reasoning?: string }> {
  const labelDescriptions = cfg.labels
    .map((l) => `- "${l.id}"${l.description ? `: ${l.description}` : ''}`)
    .join('\n');

  const prompt = `${cfg.question}

Classify this document into exactly one of the following categories:
${labelDescriptions}

Document text (first 3000 characters):
${text.slice(0, 3000)}

Respond with JSON only:
{"label": "<category_id>", "confidence": <0.0-1.0>, "reasoning": "<brief explanation>"}`;

  const endpoints = ctx.endpoints as {
    call?: (
      endpoint: string,
      payload: Record<string, unknown>,
    ) => Promise<{ content: string }>;
  };

  // No endpoint available — return a safe default
  if (!endpoints?.call) {
    return {
      label: cfg.labels[0]?.id || 'unknown',
      confidence: 0.5,
      reasoning: 'No model endpoint configured — defaulting to first label',
    };
  }

  try {
    const response = await endpoints.call(cfg.llm_endpoint || 'default', {
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 200,
    });

    const parsed = JSON.parse(response.content);

    // Validate the returned label is one we know about
    const validLabel = cfg.labels.find((l) => l.id === parsed.label);
    if (!validLabel) {
      return {
        label: cfg.labels[0]?.id || 'unknown',
        confidence: parsed.confidence ?? 0.5,
        reasoning: `Model returned unknown label "${parsed.label}", defaulted to "${cfg.labels[0]?.id}"`,
      };
    }

    return {
      label: parsed.label,
      confidence: parsed.confidence ?? 0.8,
      reasoning: parsed.reasoning,
    };
  } catch (err) {
    return {
      label: cfg.labels[cfg.labels.length - 1]?.id || 'unknown',
      confidence: 0.3,
      reasoning: `LLM classification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Step implementation
// ---------------------------------------------------------------------------

export const classifyStep: StepImplementation = {
  type: 'classify',

  async run(ctx: StepContext, config: Record<string, unknown>): Promise<StepResult> {
    const cfg = config as ClassifyConfig;

    // 1. Get document text (from previous steps, storage, or filename)
    const text = await getDocumentText(ctx, cfg.scope);

    // 2. Try keyword classification first (if method allows)
    if (cfg.method === 'keyword' || cfg.method === 'keyword_then_llm') {
      const keywordResult = classifyByKeywords(text, cfg.labels);
      if (keywordResult) {
        return {
          ok: true,
          output: {
            label: keywordResult.label,
            confidence: 1.0,
            method: 'keyword',
          },
          costUsd: 0, // keyword classification is free
        };
      }
      // keyword-only mode with no match — return fallback
      if (cfg.method === 'keyword') {
        return {
          ok: true,
          output: {
            label: cfg.labels[cfg.labels.length - 1]?.id || 'unknown',
            confidence: 0.5,
            method: 'keyword',
            reasoning: 'No keyword match found',
          },
          costUsd: 0,
        };
      }
    }

    // 3. LLM classification (for 'llm' or 'keyword_then_llm' fallback)
    const llmResult = await classifyWithLLM(ctx, text, cfg);
    return {
      ok: true,
      output: {
        label: llmResult.label,
        confidence: llmResult.confidence,
        method: 'llm',
        reasoning: llmResult.reasoning,
      },
      costUsd: 0.005,
    };
  },
};
