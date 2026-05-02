import { describe, it, expect } from 'vitest';
import { expandSugar } from '../sugar.js';
import type { RawPipelineDefinition } from '../types.js';

describe('expandSugar', () => {
  it('expands single-schema shorthand', () => {
    const raw: RawPipelineDefinition = {
      pipeline: 'invoice-intake',
      schema: 'invoice',
    };
    const { steps, edges } = expandSugar(raw);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe('extract');
    expect(steps[0]!.type).toBe('extract');
    expect(steps[0]!.config).toEqual({ schema: 'invoice' });
    expect(edges).toHaveLength(0);
  });

  it('expands single-schema + webhook shorthand', () => {
    const raw: RawPipelineDefinition = {
      pipeline: 'invoice-intake',
      schema: 'invoice',
      webhook: 'https://example.com/hook',
    };
    const { steps, edges } = expandSugar(raw);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.type).toBe('extract');
    expect(steps[1]!.type).toBe('webhook');
    expect(steps[1]!.config).toEqual({ url: 'https://example.com/hook' });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ from: 'extract', to: 'webhook' });
  });

  it('expands then to unconditional edge', () => {
    const raw: RawPipelineDefinition = {
      pipeline: 'test',
      steps: [
        { id: 'step_a', type: 'extract', then: 'step_b' },
        { id: 'step_b', type: 'tag' },
      ],
    };
    const { steps, edges } = expandSugar(raw);
    expect(steps).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ from: 'step_a', to: 'step_b' });
  });

  it('expands on to conditional edges', () => {
    const raw: RawPipelineDefinition = {
      pipeline: 'test',
      steps: [
        {
          id: 'check',
          type: 'classify',
          on: { insurance: 'extract_ins', medical: 'extract_med' },
        },
        { id: 'extract_ins', type: 'extract' },
        { id: 'extract_med', type: 'extract' },
      ],
    };
    const { edges } = expandSugar(raw);
    expect(edges).toHaveLength(2);
    expect(edges[0]!.from).toBe('check');
    expect(edges[0]!.to).toBe('extract_ins');
    expect(edges[0]!.when).toBe("output.label == 'insurance'");
    expect(edges[1]!.to).toBe('extract_med');
    expect(edges[1]!.when).toBe("output.label == 'medical'");
  });

  it('expands on with _default key to default edge', () => {
    const raw: RawPipelineDefinition = {
      pipeline: 'test',
      steps: [
        {
          id: 'check',
          type: 'classify',
          on: { invoice: 'do_extract', _default: 'tag_other' },
        },
        { id: 'do_extract', type: 'extract' },
        { id: 'tag_other', type: 'tag' },
      ],
    };
    const { edges } = expandSugar(raw);
    expect(edges).toHaveLength(2);

    const defaultEdge = edges.find((e) => e.default === true);
    expect(defaultEdge).toBeDefined();
    expect(defaultEdge!.to).toBe('tag_other');

    const conditionalEdge = edges.find((e) => e.when != null);
    expect(conditionalEdge).toBeDefined();
    expect(conditionalEdge!.to).toBe('do_extract');
  });

  it('preserves explicit edges alongside sugar', () => {
    const raw: RawPipelineDefinition = {
      pipeline: 'test',
      steps: [
        { id: 'a', type: 'extract', then: 'b' },
        { id: 'b', type: 'tag' },
      ],
      edges: [{ from: 'b', to: 'a' }], // explicit (even if it creates a cycle)
    };
    const { edges } = expandSugar(raw);
    // Should have both the explicit edge and the sugar-expanded one
    expect(edges).toHaveLength(2);
  });
});
