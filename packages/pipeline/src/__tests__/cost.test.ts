import { describe, it, expect } from 'vitest';
import { calculatePipelineCosts } from '../cost.js';
import { compilePipeline } from '../compiler.js';
import type { CompiledPipeline } from '../types.js';

function compile(yaml: string): CompiledPipeline {
  const result = compilePipeline(yaml);
  if (!result.ok) throw new Error(`Compile failed: ${result.errors.map((e) => e.message).join(', ')}`);
  return result.pipeline;
}

describe('calculatePipelineCosts', () => {
  it('computes cost for linear pipeline — one path', () => {
    const pipeline = compile(`
pipeline: linear
steps:
  - id: ocr_step
    type: ocr
  - id: extract_step
    type: extract
edges:
  - from: ocr_step
    to: extract_step
`);
    const { maxCostPerDoc, paths } = calculatePipelineCosts(pipeline);
    // ocr (0.03) + extract (0.08) = 0.11
    expect(maxCostPerDoc).toBeCloseTo(0.11, 4);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.stepIds).toEqual(['ocr_step', 'extract_step']);
    expect(paths[0]!.description).toBe('ocr_step → extract_step');
  });

  it('computes cost for branching pipeline — multiple paths', () => {
    const pipeline = compile(`
pipeline: branching
steps:
  - id: classify
    type: classify
  - id: extract
    type: extract
  - id: tag
    type: tag
edges:
  - from: classify
    to: extract
    when: "output.label == 'invoice'"
  - from: classify
    to: tag
    default: true
`);
    const { maxCostPerDoc, paths } = calculatePipelineCosts(pipeline);
    expect(paths).toHaveLength(2);
    // classify (0.005) + extract (0.08) = 0.085  vs  classify (0.005) + tag (0) = 0.005
    expect(maxCostPerDoc).toBeCloseTo(0.085, 4);
    // Sorted descending by cost
    expect(paths[0]!.cost).toBeGreaterThanOrEqual(paths[1]!.cost);
  });

  it('handles single-step pipeline', () => {
    const pipeline = compile(`
pipeline: single
schema: invoice
`);
    const { maxCostPerDoc, paths } = calculatePipelineCosts(pipeline);
    expect(paths).toHaveLength(1);
    expect(maxCostPerDoc).toBeCloseTo(0.08, 4); // extract cost
  });
});
