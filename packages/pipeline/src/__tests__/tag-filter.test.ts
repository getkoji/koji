import { describe, it, expect } from 'vitest';
import { tagStep } from '../steps/tag.js';
import { filterStep } from '../steps/filter.js';
import type { StepContext } from '../step-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    tenantId: 'tenant-1',
    documentId: 'doc-1',
    jobId: 'job-1',
    document: {
      filename: 'invoice.pdf',
      storageKey: 'store/invoice.pdf',
      mimeType: 'application/pdf',
      pageCount: 5,
      contentHash: 'abc123',
    },
    stepOutputs: {},
    db: null,
    storage: null,
    endpoints: null,
    queue: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tag step
// ---------------------------------------------------------------------------

describe('tagStep', () => {
  it('returns tags in output', async () => {
    const result = await tagStep.run(makeContext(), {
      tags: { category: 'invoice', priority: 'high' },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      tags: { category: 'invoice', priority: 'high' },
    });
    expect(result.costUsd).toBe(0);
  });

  it('handles empty tags config', async () => {
    const result = await tagStep.run(makeContext(), { tags: {} });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ tags: {} });
    expect(result.costUsd).toBe(0);
  });

  it('reports type as tag', () => {
    expect(tagStep.type).toBe('tag');
  });

  it('persists tags via db.execute when db is available', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const mockDb = {
      execute: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
      },
    };

    const result = await tagStep.run(makeContext({ db: mockDb }), {
      tags: { env: 'staging' },
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toBe(JSON.stringify({ env: 'staging' }));
  });

  it('succeeds even when db.execute throws', async () => {
    const mockDb = {
      execute: async () => {
        throw new Error('connection lost');
      },
    };

    const result = await tagStep.run(makeContext({ db: mockDb }), {
      tags: { env: 'staging' },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ tags: { env: 'staging' } });
  });
});

// ---------------------------------------------------------------------------
// Filter step
// ---------------------------------------------------------------------------

describe('filterStep', () => {
  it('reports type as filter', () => {
    expect(filterStep.type).toBe('filter');
  });

  it('passes when condition "document.page_count > 1" is true (page_count=5)', async () => {
    const result = await filterStep.run(makeContext(), {
      condition: 'document.page_count > 1',
      on_fail: 'stop',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: true });
    expect(result.costUsd).toBe(0);
  });

  it('fails when condition "document.page_count > 1" is false (page_count=1)', async () => {
    const ctx = makeContext({
      document: {
        filename: 'tiny.pdf',
        storageKey: 'store/tiny.pdf',
        mimeType: 'application/pdf',
        pageCount: 1,
        contentHash: 'def456',
      },
    });

    const result = await filterStep.run(ctx, {
      condition: 'document.page_count > 1',
      on_fail: 'stop',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: false, stopped: true });
  });

  it('on_fail: fail returns ok: false with error', async () => {
    const ctx = makeContext({
      document: {
        filename: 'tiny.pdf',
        storageKey: 'store/tiny.pdf',
        mimeType: 'application/pdf',
        pageCount: 1,
        contentHash: 'def456',
      },
    });

    const result = await filterStep.run(ctx, {
      condition: 'document.page_count > 1',
      on_fail: 'fail',
    });

    expect(result.ok).toBe(false);
    expect(result.output).toEqual({ passed: false });
    expect(result.error).toBe('Filter condition failed: document.page_count > 1');
  });

  it('on_fail: tag returns ok: true with tags', async () => {
    const ctx = makeContext({
      document: {
        filename: 'tiny.pdf',
        storageKey: 'store/tiny.pdf',
        mimeType: 'application/pdf',
        pageCount: 1,
        contentHash: 'def456',
      },
    });

    const result = await filterStep.run(ctx, {
      condition: 'document.page_count > 1',
      on_fail: 'tag',
      on_fail_tags: { reason: 'too_short' },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      passed: false,
      tags: { reason: 'too_short' },
    });
  });

  it('on_fail: tag uses default tags when on_fail_tags not provided', async () => {
    const ctx = makeContext({
      document: {
        filename: 'tiny.pdf',
        storageKey: 'store/tiny.pdf',
        mimeType: 'application/pdf',
        pageCount: 1,
        contentHash: 'def456',
      },
    });

    const result = await filterStep.run(ctx, {
      condition: 'document.page_count > 1',
      on_fail: 'tag',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      passed: false,
      tags: { filter_failed: 'document.page_count > 1' },
    });
  });

  it('on_fail: stop returns ok: true with stopped: true', async () => {
    const ctx = makeContext({
      document: {
        filename: 'tiny.pdf',
        storageKey: 'store/tiny.pdf',
        mimeType: 'application/pdf',
        pageCount: 1,
        contentHash: 'def456',
      },
    });

    const result = await filterStep.run(ctx, {
      condition: 'document.page_count > 1',
      on_fail: 'stop',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: false, stopped: true });
  });

  it('string comparison: document.mime_type == \'application/pdf\'', async () => {
    const result = await filterStep.run(makeContext(), {
      condition: "document.mime_type == 'application/pdf'",
      on_fail: 'fail',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: true });
  });

  it('string comparison fails correctly', async () => {
    const result = await filterStep.run(makeContext(), {
      condition: "document.mime_type == 'image/png'",
      on_fail: 'fail',
    });

    expect(result.ok).toBe(false);
    expect(result.output).toEqual({ passed: false });
  });

  it('unparseable condition passes by default', async () => {
    const result = await filterStep.run(makeContext(), {
      condition: 'this is not a valid condition!!!',
      on_fail: 'fail',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: true });
  });

  it('evaluates conditions against upstream step outputs', async () => {
    const ctx = makeContext({
      stepOutputs: {
        classify: { output: { label: 'invoice', confidence: 0.95 } },
      },
    });

    const result = await filterStep.run(ctx, {
      condition: 'steps.classify.output.confidence > 0.5',
      on_fail: 'fail',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: true });
  });

  it('!= operator works', async () => {
    const result = await filterStep.run(makeContext(), {
      condition: "document.mime_type != 'image/png'",
      on_fail: 'fail',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: true });
  });

  it('>= operator works', async () => {
    const result = await filterStep.run(makeContext(), {
      condition: 'document.page_count >= 5',
      on_fail: 'fail',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: true });
  });

  it('<= operator works', async () => {
    const result = await filterStep.run(makeContext(), {
      condition: 'document.page_count <= 5',
      on_fail: 'fail',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ passed: true });
  });
});
