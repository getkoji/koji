import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webhookStep } from '../steps/webhook';
import { transformStep } from '../steps/transform';
import type { StepContext, StepOutput } from '../steps/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<StepContext>): StepContext {
  return {
    tenantId: 'tenant-1',
    documentId: 'doc-1',
    jobId: 'job-1',
    document: {
      filename: 'invoice.pdf',
      storageKey: 'uploads/invoice.pdf',
      mimeType: 'application/pdf',
      pageCount: 3,
      contentHash: 'abc123',
    },
    stepOutputs: {},
    db: {},
    storage: {},
    endpoints: {},
    queue: {},
    ...overrides,
  };
}

function makeStepOutput(
  stepId: string,
  output: Record<string, unknown>,
): StepOutput {
  return { stepId, stepType: 'extract', output, durationMs: 100, costUsd: 0.08 };
}

// ---------------------------------------------------------------------------
// Webhook step tests
// ---------------------------------------------------------------------------

describe('webhookStep', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns error when URL is missing', async () => {
    const result = await webhookStep.run(makeCtx(), {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Webhook URL is required');
  });

  it('builds correct payload for result mode', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'extract-1': makeStepOutput('extract-1', {
          fields: { vendor: 'Acme', total: 100 },
        }),
      },
    });

    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    await webhookStep.run(ctx, { url: 'https://example.com/hook', payload: 'result' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.document_id).toBe('doc-1');
    expect(body.job_id).toBe('job-1');
    expect(body.tenant_id).toBe('tenant-1');
    expect(body.extraction).toEqual({ fields: { vendor: 'Acme', total: 100 } });
    expect(body.document.filename).toBe('invoice.pdf');
  });

  it('builds correct payload for document mode', async () => {
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    await webhookStep.run(makeCtx(), { url: 'https://example.com/hook', payload: 'document' });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.document_id).toBe('doc-1');
    expect(body.filename).toBe('invoice.pdf');
    expect(body.storage_key).toBe('uploads/invoice.pdf');
    expect(body.mime_type).toBe('application/pdf');
    expect(body.page_count).toBe(3);
    expect(body.content_hash).toBe('abc123');
  });

  it('builds correct payload for metadata mode', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'tag-1': makeStepOutput('tag-1', { tagged: true }),
      },
    });
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    await webhookStep.run(ctx, { url: 'https://example.com/hook', payload: 'metadata' });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.document_id).toBe('doc-1');
    expect(body.step_outputs).toEqual({ 'tag-1': { tagged: true } });
  });

  it('HMAC signing adds correct header', async () => {
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    await webhookStep.run(makeCtx(), {
      url: 'https://example.com/hook',
      signing_secret: 'test-secret',
    });

    const headers = fetchSpy.mock.calls[0]![1].headers;
    expect(headers['X-Koji-Signature']).toBeDefined();
    expect(headers['X-Koji-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('handles 4xx as non-retryable failure', async () => {
    fetchSpy.mockResolvedValue(new Response('bad request', { status: 400 }));

    const result = await webhookStep.run(makeCtx(), {
      url: 'https://example.com/hook',
      retry: { max_attempts: 3 },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Webhook returned 400');
    expect(result.output.attempts).toBe(1); // no retries on 4xx
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns ok for 2xx response', async () => {
    fetchSpy.mockResolvedValue(new Response('{"received": true}', { status: 200 }));

    const result = await webhookStep.run(makeCtx(), { url: 'https://example.com/hook' });

    expect(result.ok).toBe(true);
    expect(result.output.status_code).toBe(200);
    expect(result.output.attempts).toBe(1);
    expect(result.costUsd).toBe(0);
  });

  it('retries on 5xx and fails after max attempts', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 502 }));

    const result = await webhookStep.run(makeCtx(), {
      url: 'https://example.com/hook',
      retry: { max_attempts: 2, backoff: 'linear' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Webhook failed after 2 attempts');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('uses custom method and headers', async () => {
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    await webhookStep.run(makeCtx(), {
      url: 'https://example.com/hook',
      method: 'PUT',
      headers: { 'X-Custom': 'value' },
    });

    const opts = fetchSpy.mock.calls[0]![1];
    expect(opts.method).toBe('PUT');
    expect(opts.headers['X-Custom']).toBe('value');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('uses custom payload when mode is custom', async () => {
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    await webhookStep.run(makeCtx(), {
      url: 'https://example.com/hook',
      payload: 'custom',
      custom_payload: { foo: 'bar', nested: { a: 1 } },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body).toEqual({ foo: 'bar', nested: { a: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Transform step tests
// ---------------------------------------------------------------------------

describe('transformStep', () => {
  it('empty operations returns empty result', async () => {
    const result = await transformStep.run(makeCtx(), { operations: [] });
    expect(result.ok).toBe(true);
    expect(result.output.fields).toEqual({});
    expect(result.output.operation_count).toBe(0);
  });

  it('no operations config returns empty output', async () => {
    const result = await transformStep.run(makeCtx(), {});
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({});
  });

  it('rename operation moves a field', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { vendor_name: 'Acme' } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ rename: { from: 'vendor_name', to: 'vendor' } }],
    });

    expect(result.ok).toBe(true);
    const fields = result.output.fields as Record<string, unknown>;
    expect(fields.vendor).toBe('Acme');
    expect(fields.vendor_name).toBeUndefined();
  });

  it('set operation adds a field', async () => {
    const result = await transformStep.run(makeCtx(), {
      operations: [{ set: { field: 'source', value: 'koji' } }],
    });

    expect(result.ok).toBe(true);
    const fields = result.output.fields as Record<string, unknown>;
    expect(fields.source).toBe('koji');
  });

  it('remove operation deletes a field', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { a: 1, b: 2 } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ remove: { field: 'b' } }],
    });

    const fields = result.output.fields as Record<string, unknown>;
    expect(fields.a).toBe(1);
    expect(fields.b).toBeUndefined();
  });

  it('copy operation duplicates a field', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { total: 99 } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ copy: { from: 'total', to: 'amount' } }],
    });

    const fields = result.output.fields as Record<string, unknown>;
    expect(fields.total).toBe(99);
    expect(fields.amount).toBe(99);
  });

  it('lowercase operation', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { name: 'ACME CORP' } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ lowercase: { field: 'name' } }],
    });

    expect((result.output.fields as Record<string, unknown>).name).toBe('acme corp');
  });

  it('uppercase operation', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { code: 'abc' } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ uppercase: { field: 'code' } }],
    });

    expect((result.output.fields as Record<string, unknown>).code).toBe('ABC');
  });

  it('trim operation', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { note: '  hello  ' } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ trim: { field: 'note' } }],
    });

    expect((result.output.fields as Record<string, unknown>).note).toBe('hello');
  });

  it('template substitution with {{field_name}}', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { first: 'Jane', last: 'Doe' } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ template: { field: 'full_name', value: '{{first}} {{last}}' } }],
    });

    expect((result.output.fields as Record<string, unknown>).full_name).toBe('Jane Doe');
  });

  it('{{now}} and {{document.filename}} substitution in set', async () => {
    const result = await transformStep.run(makeCtx(), {
      operations: [
        { set: { field: 'processed_at', value: '{{now}}' } },
        { set: { field: 'source_file', value: '{{document.filename}}' } },
      ],
    });

    const fields = result.output.fields as Record<string, unknown>;
    // {{now}} should be replaced with an ISO timestamp
    expect(fields.processed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fields.source_file).toBe('invoice.pdf');
  });

  it('operations apply in order', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { x: 'hello' } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [
        { uppercase: { field: 'x' } },         // x = 'HELLO'
        { copy: { from: 'x', to: 'y' } },      // y = 'HELLO'
        { set: { field: 'x', value: 'reset' } }, // x = 'reset'
      ],
    });

    const fields = result.output.fields as Record<string, unknown>;
    expect(fields.x).toBe('reset');
    expect(fields.y).toBe('HELLO');

    const applied = result.output.operations_applied as string[];
    expect(applied).toHaveLength(3);
    expect(applied[0]).toContain('uppercase');
    expect(applied[1]).toContain('copy');
    expect(applied[2]).toContain('set');
  });

  it('merges fields from multiple upstream steps', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        'e1': makeStepOutput('e1', { fields: { a: 1 } }),
        'e2': makeStepOutput('e2', { fields: { b: 2 } }),
      },
    });

    const result = await transformStep.run(ctx, {
      operations: [{ set: { field: 'c', value: 3 } }],
    });

    const fields = result.output.fields as Record<string, unknown>;
    expect(fields.a).toBe(1);
    expect(fields.b).toBe(2);
    expect(fields.c).toBe(3);
  });

  it('costUsd is always 0', async () => {
    const result = await transformStep.run(makeCtx(), {
      operations: [{ set: { field: 'x', value: 1 } }],
    });
    expect(result.costUsd).toBe(0);
  });
});
