/**
 * Split step — detect document boundaries in a multi-document PDF
 * and produce sub-document page ranges.
 *
 * The split step does NOT create child documents directly — it returns
 * page groups that the DAG runner uses to fan out execution. This keeps
 * the step implementation pure (no DB/storage side effects).
 *
 * Detection methods:
 * - "fixed": Manual page ranges from config
 * - "llm": Send page headers to LLM for boundary detection
 * - "keyword": Match page headers against keyword patterns
 */

import type { StepImplementation, StepContext, StepResult } from './types';

export interface PageGroup {
  startPage: number;
  endPage: number;
  type: string;
  confidence: number;
}

export const splitStep: StepImplementation = {
  type: 'split',

  async run(ctx: StepContext, config: Record<string, unknown>): Promise<StepResult> {
    const method = (config.method as string) || 'llm';

    if (method === 'fixed') {
      return handleFixedSplit(config);
    }

    // For LLM and keyword methods, we need page headers from upstream.
    // The DAG runner injects these into stepOutputs as __page_headers.
    const pageHeaders = ctx.stepOutputs.__page_headers?.output?.headers as
      Array<{ page: number; header_text: string }> | undefined;

    if (!pageHeaders || pageHeaders.length === 0) {
      return {
        ok: false,
        output: { groups: [], error: 'No page headers available — parse step may have failed' },
        costUsd: 0,
      };
    }

    if (method === 'keyword') {
      return handleKeywordSplit(pageHeaders, config);
    }

    // Default: LLM-based boundary detection
    return handleLlmSplit(pageHeaders, config, ctx);
  },
};

function handleFixedSplit(config: Record<string, unknown>): StepResult {
  const ranges = config.page_ranges as Array<{ start: number; end: number; type?: string }> | undefined;
  if (!ranges || ranges.length === 0) {
    return { ok: false, output: { groups: [] }, costUsd: 0, error: 'No page_ranges configured' };
  }
  const groups: PageGroup[] = ranges.map((r) => ({
    startPage: r.start,
    endPage: r.end,
    type: r.type || 'document',
    confidence: 1.0,
  }));
  return { ok: true, output: { groups, method: 'fixed', count: groups.length }, costUsd: 0 };
}

function handleKeywordSplit(
  headers: Array<{ page: number; header_text: string }>,
  config: Record<string, unknown>,
): StepResult {
  const labels = (config.labels as Array<{ id: string; keywords: string[] }>) || [];
  if (labels.length === 0) {
    return { ok: false, output: { groups: [] }, costUsd: 0, error: 'No labels configured for keyword split' };
  }

  const groups: PageGroup[] = [];
  let currentGroup: PageGroup | null = null;

  for (const h of headers) {
    const text = h.header_text.toLowerCase();
    let matched: string | null = null;

    for (const label of labels) {
      const hits = (label.keywords || []).filter((kw) => text.includes(kw.toLowerCase()));
      if (hits.length >= 1) {
        matched = label.id;
        break;
      }
    }

    if (matched) {
      // New document boundary
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { startPage: h.page, endPage: h.page, type: matched, confidence: 0.9 };
    } else if (currentGroup) {
      // Continuation of current document
      currentGroup.endPage = h.page;
    }
    // Pages before any match are ignored (or could be grouped as "unknown")
  }
  if (currentGroup) groups.push(currentGroup);

  return {
    ok: true,
    output: { groups, method: 'keyword', count: groups.length },
    costUsd: 0,
  };
}

async function handleLlmSplit(
  headers: Array<{ page: number; header_text: string }>,
  config: Record<string, unknown>,
  ctx: StepContext,
): Promise<StepResult> {
  // The LLM provider is injected by the DAG runner as __llm_provider in stepOutputs
  const provider = (ctx as any).__llm_provider;
  if (!provider?.generate) {
    return {
      ok: false,
      output: { groups: [] },
      costUsd: 0,
      error: 'No LLM provider available for split detection',
    };
  }

  const labels = (config.labels as Array<{ id: string; description?: string }>) || [];
  const labelDesc = labels.length > 0
    ? `\nKnown document types:\n${labels.map((l) => `- "${l.id}"${l.description ? `: ${l.description}` : ''}`).join('\n')}\n`
    : '';

  const headerList = headers
    .map((h) => `Page ${h.page}: "${h.header_text}"`)
    .join('\n');

  const prompt = `This is a multi-document PDF submission. Here are the first ~200 characters from each page:

${headerList}
${labelDesc}
Identify where new documents begin. Group consecutive pages that belong to the same document.

Return a JSON array of document groups:
[{"start_page": 1, "end_page": 3, "type": "document_type"},...]

Each group should have start_page, end_page (both 1-indexed, inclusive), and type (a short identifier).
Return ONLY valid JSON, no explanation.`;

  try {
    const raw = await provider.generate(prompt, true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try extracting array from response
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Could not parse LLM response as JSON array');
    }

    const arr = Array.isArray(parsed) ? parsed : [];
    const groups: PageGroup[] = arr.map((g: any) => ({
      startPage: g.start_page ?? g.startPage ?? 1,
      endPage: g.end_page ?? g.endPage ?? 1,
      type: g.type ?? 'document',
      confidence: g.confidence ?? 0.85,
    }));

    return {
      ok: true,
      output: { groups, method: 'llm', count: groups.length },
      costUsd: 0.005,
    };
  } catch (err) {
    return {
      ok: false,
      output: { groups: [] },
      costUsd: 0.005,
      error: `LLM split detection failed: ${(err as Error).message}`,
    };
  }
}
