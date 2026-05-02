import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePipeline, type ExecutorDeps } from '../executor';
import { registerStep } from '../steps/registry';
import type { CompiledPipeline } from '../types';
import type { StepOutput } from '../steps/types';

// ---------------------------------------------------------------------------
// Mock step implementations
// ---------------------------------------------------------------------------

function registerMockSteps() {
  registerStep({
    type: 'extract',
    async run(_ctx, config) {
      return {
        ok: true,
        output: { extracted: true, schema: config.schema },
        costUsd: 0.08,
      };
    },
  });

  registerStep({
    type: 'classify',
    async run(_ctx, config) {
      // Return label from config so tests can control routing
      const label = (config.mockLabel as string) || 'invoice';
      return {
        ok: true,
        output: { label },
        costUsd: 0.02,
      };
    },
  });

  registerStep({
    type: 'tag',
    async run() {
      return { ok: true, output: { tagged: true }, costUsd: 0.01 };
    },
  });

  registerStep({
    type: 'webhook',
    async run() {
      return { ok: true, output: { delivered: true }, costUsd: 0 };
    },
  });

  registerStep({
    type: 'transform',
    async run() {
      return { ok: true, output: { transformed: true }, costUsd: 0 };
    },
  });

  registerStep({
    type: 'filter',
    async run() {
      return { ok: true, output: { passed: true }, costUsd: 0 };
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ExecutorDeps>): ExecutorDeps {
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
    db: {},
    storage: {},
    endpoints: {},
    queue: {},
    onStepStart: vi.fn().mockResolvedValue(undefined),
    onStepComplete: vi.fn().mockResolvedValue(undefined),
    onStepFail: vi.fn().mockResolvedValue(undefined),
    getCompletedSteps: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function linearPipeline(): CompiledPipeline {
  return {
    id: 'pipe-1',
    version: 1,
    steps: [
      { id: 'step-a', type: 'extract', config: { schema: 'invoice' } },
      { id: 'step-b', type: 'tag', config: {} },
    ],
    edges: [{ from: 'step-a', to: 'step-b', condition: null, isDefault: false }],
    entryStepId: 'step-a',
    settings: { max_steps: 50, timeout_ms: 60000, on_no_match: 'skip' },
  };
}

function branchingPipeline(): CompiledPipeline {
  return {
    id: 'pipe-2',
    version: 1,
    steps: [
      { id: 'classify-step', type: 'classify', config: { mockLabel: 'invoice' } },
      { id: 'extract-step', type: 'extract', config: { schema: 'invoice' } },
      { id: 'tag-step', type: 'tag', config: {} },
    ],
    edges: [
      {
        from: 'classify-step',
        to: 'extract-step',
        condition: { field: 'output.label', op: 'eq', value: 'invoice' },
        isDefault: false,
      },
      {
        from: 'classify-step',
        to: 'tag-step',
        condition: null,
        isDefault: true,
      },
    ],
    entryStepId: 'classify-step',
    settings: { max_steps: 50, timeout_ms: 60000, on_no_match: 'skip' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executePipeline', () => {
  beforeEach(() => {
    registerMockSteps();
  });

  it('linear pipeline (A -> B) executes both steps in order', async () => {
    const deps = makeDeps();
    const result = await executePipeline(linearPipeline(), deps);

    expect(result.status).toBe('completed');
    expect(result.stepOutputs).toHaveLength(2);
    expect(result.stepOutputs[0]!.stepId).toBe('step-a');
    expect(result.stepOutputs[0]!.stepType).toBe('extract');
    expect(result.stepOutputs[1]!.stepId).toBe('step-b');
    expect(result.stepOutputs[1]!.stepType).toBe('tag');
    expect(result.finalStepId).toBe('step-b');
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('branching pipeline follows correct edge based on condition', async () => {
    const deps = makeDeps();
    const pipeline = branchingPipeline();
    const result = await executePipeline(pipeline, deps);

    expect(result.status).toBe('completed');
    expect(result.stepOutputs).toHaveLength(2);
    expect(result.stepOutputs[0]!.stepId).toBe('classify-step');
    expect(result.stepOutputs[1]!.stepId).toBe('extract-step');
    // tag-step should NOT have run (only the invoice branch matched)
  });

  it('default edge fires when no condition matches', async () => {
    const deps = makeDeps();
    const pipeline = branchingPipeline();
    // Override classify to return a label that doesn't match any condition
    pipeline.steps[0]!.config = { mockLabel: 'receipt' };

    const result = await executePipeline(pipeline, deps);

    expect(result.status).toBe('completed');
    expect(result.stepOutputs).toHaveLength(2);
    expect(result.stepOutputs[0]!.stepId).toBe('classify-step');
    // Should follow default edge to tag-step
    expect(result.stepOutputs[1]!.stepId).toBe('tag-step');
  });

  it('terminal step returns completed status', async () => {
    const deps = makeDeps();
    // Single step, no edges
    const pipeline: CompiledPipeline = {
      id: 'pipe-single',
      version: 1,
      steps: [{ id: 'only-step', type: 'tag', config: {} }],
      edges: [],
      entryStepId: 'only-step',
      settings: { max_steps: 50, timeout_ms: 60000, on_no_match: 'skip' },
    };

    const result = await executePipeline(pipeline, deps);

    expect(result.status).toBe('completed');
    expect(result.stepOutputs).toHaveLength(1);
    expect(result.finalStepId).toBe('only-step');
  });

  it('unknown step type returns failed status', async () => {
    const deps = makeDeps();
    const pipeline: CompiledPipeline = {
      id: 'pipe-bad',
      version: 1,
      steps: [{ id: 'bad-step', type: 'extract' as never, config: {} }],
      edges: [],
      entryStepId: 'bad-step',
      settings: { max_steps: 50, timeout_ms: 60000, on_no_match: 'skip' },
    };

    // Clear registry to simulate missing implementation
    const { registerStep: reg } = await import('../steps/registry');
    // Re-register only tag (not extract) — a bit hacky but we need to test the missing case
    // Instead, reference a step type that was never registered
    pipeline.steps[0]!.type = 'nonexistent' as never;

    const result = await executePipeline(pipeline, deps);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No implementation registered');
    // Re-register for other tests
    registerMockSteps();
  });

  it('crash recovery: completed steps are skipped on re-execution', async () => {
    const completedOutput: StepOutput = {
      stepId: 'step-a',
      stepType: 'extract',
      output: { extracted: true, schema: 'invoice' },
      durationMs: 100,
      costUsd: 0.08,
    };

    const deps = makeDeps({
      getCompletedSteps: vi.fn().mockResolvedValue({ 'step-a': completedOutput }),
    });

    const result = await executePipeline(linearPipeline(), deps);

    expect(result.status).toBe('completed');
    expect(result.stepOutputs).toHaveLength(2); // completed + newly run
    // step-a should be the recovered one, step-b should be newly run
    expect(result.stepOutputs[0]!.stepId).toBe('step-a');
    expect(result.stepOutputs[1]!.stepId).toBe('step-b');

    // onStepStart should only have been called for step-b (the non-recovered step)
    const onStepStart = deps.onStepStart as ReturnType<typeof vi.fn>;
    expect(onStepStart).toHaveBeenCalledTimes(1);
    expect(onStepStart).toHaveBeenCalledWith('step-b', 'tag', expect.any(Number));
  });

  it('step failure stops pipeline and returns error', async () => {
    // Register a failing extract step
    registerStep({
      type: 'extract',
      async run() {
        return { ok: false, output: {}, costUsd: 0, error: 'Model unavailable' };
      },
    });

    const deps = makeDeps();
    const result = await executePipeline(linearPipeline(), deps);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Model unavailable');
    expect(result.finalStepId).toBe('step-a');
    expect(result.stepOutputs).toHaveLength(0); // failed step is not added to outputs

    const onStepFail = deps.onStepFail as ReturnType<typeof vi.fn>;
    expect(onStepFail).toHaveBeenCalledWith('step-a', 'Model unavailable');

    // Re-register working mock
    registerMockSteps();
  });

  it('step that throws stops pipeline and returns error', async () => {
    registerStep({
      type: 'extract',
      async run() {
        throw new Error('Connection refused');
      },
    });

    const deps = makeDeps();
    const result = await executePipeline(linearPipeline(), deps);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Connection refused');
    expect(result.finalStepId).toBe('step-a');

    const onStepFail = deps.onStepFail as ReturnType<typeof vi.fn>;
    expect(onStepFail).toHaveBeenCalledWith('step-a', 'Connection refused');

    registerMockSteps();
  });

  it('step order is tracked correctly', async () => {
    const deps = makeDeps();
    const result = await executePipeline(linearPipeline(), deps);

    const onStepStart = deps.onStepStart as ReturnType<typeof vi.fn>;
    expect(onStepStart).toHaveBeenCalledTimes(2);
    // First step should be order 1, second should be order 2
    expect(onStepStart).toHaveBeenNthCalledWith(1, 'step-a', 'extract', 1);
    expect(onStepStart).toHaveBeenNthCalledWith(2, 'step-b', 'tag', 2);
  });

  it('onStepStart and onStepComplete callbacks are called for each step', async () => {
    const deps = makeDeps();
    await executePipeline(linearPipeline(), deps);

    const onStepStart = deps.onStepStart as ReturnType<typeof vi.fn>;
    const onStepComplete = deps.onStepComplete as ReturnType<typeof vi.fn>;

    expect(onStepStart).toHaveBeenCalledTimes(2);
    expect(onStepComplete).toHaveBeenCalledTimes(2);

    // Verify onStepComplete was called with correct outputs
    expect(onStepComplete).toHaveBeenCalledWith(
      'step-a',
      expect.objectContaining({ stepId: 'step-a', stepType: 'extract' }),
    );
    expect(onStepComplete).toHaveBeenCalledWith(
      'step-b',
      expect.objectContaining({ stepId: 'step-b', stepType: 'tag' }),
    );
  });

  it('missing step ID in pipeline returns failed', async () => {
    const deps = makeDeps();
    const pipeline: CompiledPipeline = {
      id: 'pipe-missing',
      version: 1,
      steps: [{ id: 'step-a', type: 'extract', config: {} }],
      edges: [{ from: 'step-a', to: 'step-ghost', condition: null, isDefault: false }],
      entryStepId: 'step-a',
      settings: { max_steps: 50, timeout_ms: 60000, on_no_match: 'skip' },
    };

    const result = await executePipeline(pipeline, deps);

    // step-a completes, then step-ghost is not found
    expect(result.status).toBe('failed');
    expect(result.error).toContain("Step 'step-ghost' not found");
  });

  it('crash recovery with terminal step returns completed immediately', async () => {
    const completedOutput: StepOutput = {
      stepId: 'only-step',
      stepType: 'tag',
      output: { tagged: true },
      durationMs: 50,
      costUsd: 0.01,
    };

    const deps = makeDeps({
      getCompletedSteps: vi.fn().mockResolvedValue({ 'only-step': completedOutput }),
    });

    const pipeline: CompiledPipeline = {
      id: 'pipe-single',
      version: 1,
      steps: [{ id: 'only-step', type: 'tag', config: {} }],
      edges: [],
      entryStepId: 'only-step',
      settings: { max_steps: 50, timeout_ms: 60000, on_no_match: 'skip' },
    };

    const result = await executePipeline(pipeline, deps);

    expect(result.status).toBe('completed');
    expect(result.stepOutputs).toHaveLength(1);
    expect(result.finalStepId).toBe('only-step');

    // No new steps should have been started
    const onStepStart = deps.onStepStart as ReturnType<typeof vi.fn>;
    expect(onStepStart).not.toHaveBeenCalled();
  });
});
