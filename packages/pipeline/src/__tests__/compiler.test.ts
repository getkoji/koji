import { describe, it, expect } from 'vitest';
import { compilePipeline } from '../compiler.js';

describe('compilePipeline', () => {
  it('compiles single-schema shorthand to one-step pipeline', () => {
    const yaml = `
pipeline: invoice-intake
schema: invoice
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pipeline.steps).toHaveLength(1);
    expect(result.pipeline.steps[0]!.type).toBe('extract');
    expect(result.pipeline.steps[0]!.config).toEqual({ schema: 'invoice' });
    expect(result.pipeline.entryStepId).toBe('extract');
    expect(result.pipeline.terminalStepIds).toEqual(['extract']);
  });

  it('compiles single-schema + webhook to two-step pipeline', () => {
    const yaml = `
pipeline: invoice-intake
schema: invoice
webhook: https://example.com/hook
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pipeline.steps).toHaveLength(2);
    expect(result.pipeline.entryStepId).toBe('extract');
    expect(result.pipeline.terminalStepIds).toEqual(['webhook']);
    expect(result.pipeline.edges).toHaveLength(1);
    expect(result.pipeline.edges[0]!.from).toBe('extract');
    expect(result.pipeline.edges[0]!.to).toBe('webhook');
  });

  it('compiles two-step classify -> extract with on sugar', () => {
    const yaml = `
pipeline: doc-router
steps:
  - id: classify
    type: classify
    on:
      invoice: do_extract
      _default: tag_other
  - id: do_extract
    type: extract
    config:
      schema: invoice
  - id: tag_other
    type: tag
    config:
      label: unrouted
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pipeline.steps).toHaveLength(3);
    expect(result.pipeline.entryStepId).toBe('classify');
    expect(result.pipeline.terminalStepIds).toContain('do_extract');
    expect(result.pipeline.terminalStepIds).toContain('tag_other');
    expect(result.pipeline.edges).toHaveLength(2);

    const conditionalEdge = result.pipeline.edges.find((e) => !e.isDefault);
    expect(conditionalEdge).toBeDefined();
    expect(conditionalEdge!.condition).not.toBeNull();

    const defaultEdge = result.pipeline.edges.find((e) => e.isDefault);
    expect(defaultEdge).toBeDefined();
    expect(defaultEdge!.to).toBe('tag_other');
  });

  it('compiles three-step pipeline with explicit edges', () => {
    const yaml = `
pipeline: multi-classify
steps:
  - id: first_classify
    type: classify
  - id: second_classify
    type: classify
  - id: final_extract
    type: extract
edges:
  - from: first_classify
    to: second_classify
  - from: second_classify
    to: final_extract
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pipeline.steps).toHaveLength(3);
    expect(result.pipeline.entryStepId).toBe('first_classify');
    expect(result.pipeline.terminalStepIds).toEqual(['final_extract']);
  });

  it('returns parse error for invalid YAML', () => {
    const yaml = `{{{not yaml`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('YAML_PARSE_ERROR');
  });

  it('rejects cycle A -> B -> A', () => {
    const yaml = `
pipeline: cyclic
steps:
  - id: a
    type: extract
  - id: b
    type: tag
edges:
  - from: a
    to: b
  - from: b
    to: a
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('CYCLE_DETECTED');
  });

  it('detects unreachable step', () => {
    const yaml = `
pipeline: unreachable
steps:
  - id: entry
    type: extract
  - id: orphan
    type: tag
edges:
  - from: orphan
    to: entry
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either MULTIPLE_ENTRY_POINTS or UNREACHABLE_STEP or CYCLE_DETECTED
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('detects missing edge target', () => {
    const yaml = `
pipeline: missing-target
steps:
  - id: entry
    type: extract
edges:
  - from: entry
    to: nonexistent
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('EDGE_TARGET_NOT_FOUND');
  });

  it('rejects when max steps exceeded', () => {
    // Build a pipeline with 25 steps, max is 20
    const steps = Array.from({ length: 25 }, (_, i) => `  - id: step_${i}\n    type: tag`).join('\n');
    const edges = Array.from({ length: 24 }, (_, i) => `  - from: step_${i}\n    to: step_${i + 1}`).join('\n');
    const yaml = `
pipeline: too-many
settings:
  max_steps: 20
steps:
${steps}
edges:
${edges}
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('MAX_STEPS_EXCEEDED');
  });

  it('rejects empty pipeline', () => {
    const yaml = `
pipeline: empty
steps: []
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('EMPTY_PIPELINE');
  });

  it('computes estimated max cost per doc', () => {
    const yaml = `
pipeline: costed
steps:
  - id: ocr_step
    type: ocr
  - id: extract_step
    type: extract
edges:
  - from: ocr_step
    to: extract_step
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ocr (0.03) + extract (0.08) = 0.11
    expect(result.pipeline.estimatedMaxCostPerDoc).toBeCloseTo(0.11, 4);
  });

  it('returns error for missing pipeline name', () => {
    const yaml = `
schema: invoice
`;
    const result = compilePipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('MISSING_PIPELINE_NAME');
  });
});
