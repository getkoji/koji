import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../condition';

describe('evaluateCondition', () => {
  it('eq: matches equal values', () => {
    expect(evaluateCondition({ field: 'output.label', op: 'eq', value: 'invoice' }, { output: { label: 'invoice' } })).toBe(true);
    expect(evaluateCondition({ field: 'output.label', op: 'eq', value: 'invoice' }, { output: { label: 'receipt' } })).toBe(false);
  });

  it('neq: matches unequal values', () => {
    expect(evaluateCondition({ field: 'output.label', op: 'neq', value: 'invoice' }, { output: { label: 'receipt' } })).toBe(true);
    expect(evaluateCondition({ field: 'output.label', op: 'neq', value: 'invoice' }, { output: { label: 'invoice' } })).toBe(false);
  });

  it('gt/gte/lt/lte: numeric comparisons', () => {
    expect(evaluateCondition({ field: 'output.score', op: 'gt', value: 0.5 }, { output: { score: 0.9 } })).toBe(true);
    expect(evaluateCondition({ field: 'output.score', op: 'gt', value: 0.5 }, { output: { score: 0.3 } })).toBe(false);
    expect(evaluateCondition({ field: 'output.score', op: 'gte', value: 0.5 }, { output: { score: 0.5 } })).toBe(true);
    expect(evaluateCondition({ field: 'output.score', op: 'lt', value: 0.5 }, { output: { score: 0.3 } })).toBe(true);
    expect(evaluateCondition({ field: 'output.score', op: 'lte', value: 0.5 }, { output: { score: 0.5 } })).toBe(true);
  });

  it('in: checks membership in array', () => {
    expect(evaluateCondition({ field: 'output.label', op: 'in', value: ['invoice', 'receipt'] }, { output: { label: 'invoice' } })).toBe(true);
    expect(evaluateCondition({ field: 'output.label', op: 'in', value: ['invoice', 'receipt'] }, { output: { label: 'contract' } })).toBe(false);
  });

  it('contains: substring check', () => {
    expect(evaluateCondition({ field: 'output.text', op: 'contains', value: 'hello' }, { output: { text: 'say hello world' } })).toBe(true);
    expect(evaluateCondition({ field: 'output.text', op: 'contains', value: 'goodbye' }, { output: { text: 'say hello world' } })).toBe(false);
  });

  it('matches: regex check', () => {
    expect(evaluateCondition({ field: 'output.text', op: 'matches', value: '^INV-\\d+' }, { output: { text: 'INV-12345' } })).toBe(true);
    expect(evaluateCondition({ field: 'output.text', op: 'matches', value: '^INV-\\d+' }, { output: { text: 'PO-12345' } })).toBe(false);
  });

  it('resolves nested paths', () => {
    expect(evaluateCondition({ field: 'steps.classify.output.label', op: 'eq', value: 'invoice' }, {
      steps: { classify: { output: { label: 'invoice' } } },
    })).toBe(true);
  });

  it('returns false for missing paths', () => {
    expect(evaluateCondition({ field: 'output.missing.deep', op: 'eq', value: 'x' }, { output: {} })).toBe(false);
  });
});
