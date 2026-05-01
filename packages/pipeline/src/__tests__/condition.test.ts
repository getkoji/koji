import { describe, it, expect } from 'vitest';
import { parseCondition, evaluateCondition, ConditionParseError } from '../condition.js';

describe('parseCondition', () => {
  it('parses simple equality', () => {
    const ast = parseCondition("output.label == 'insurance'");
    expect(ast).toEqual({
      type: 'comparison',
      left: { type: 'ref', path: ['output', 'label'] },
      op: '==',
      right: 'insurance',
    });
  });

  it('parses numeric comparison', () => {
    const ast = parseCondition('output.confidence >= 0.8');
    expect(ast).toEqual({
      type: 'comparison',
      left: { type: 'ref', path: ['output', 'confidence'] },
      op: '>=',
      right: 0.8,
    });
  });

  it('parses membership (in)', () => {
    const ast = parseCondition("output.label in ['policy', 'certificate']");
    expect(ast).toEqual({
      type: 'membership',
      left: { type: 'ref', path: ['output', 'label'] },
      op: 'in',
      right: ['policy', 'certificate'],
    });
  });

  it('parses negated membership (not in)', () => {
    const ast = parseCondition("output.label not in ['other']");
    expect(ast).toEqual({
      type: 'membership',
      left: { type: 'ref', path: ['output', 'label'] },
      op: 'not_in',
      right: ['other'],
    });
  });

  it('parses contains', () => {
    const ast = parseCondition("output.label contains 'insur'");
    expect(ast).toEqual({
      type: 'contains',
      left: { type: 'ref', path: ['output', 'label'] },
      right: 'insur',
    });
  });

  it('parses logical AND', () => {
    const ast = parseCondition("output.label == 'invoice' and document.page_count > 5");
    expect(ast.type).toBe('and');
  });

  it('parses logical OR', () => {
    const ast = parseCondition("output.label == 'policy' or output.label == 'certificate'");
    expect(ast.type).toBe('or');
  });

  it('parses NOT', () => {
    const ast = parseCondition("not output.label == 'other'");
    expect(ast.type).toBe('not');
  });

  it('parses nested parentheses', () => {
    const ast = parseCondition("(output.label == 'a' or output.label == 'b') and output.confidence > 0.8");
    expect(ast.type).toBe('and');
    if (ast.type !== 'and') return;
    expect(ast.left.type).toBe('or');
    expect(ast.right.type).toBe('comparison');
  });

  it('throws on invalid syntax with position', () => {
    expect(() => parseCondition('output.label @@@ 5')).toThrow(ConditionParseError);
    try {
      parseCondition('output.label @@@ 5');
    } catch (err) {
      expect(err).toBeInstanceOf(ConditionParseError);
      expect((err as ConditionParseError).pos).toBeGreaterThanOrEqual(0);
    }
  });

  it('parses boolean values', () => {
    const ast = parseCondition('output.active == true');
    expect(ast).toEqual({
      type: 'comparison',
      left: { type: 'ref', path: ['output', 'active'] },
      op: '==',
      right: true,
    });
  });

  it('parses null values', () => {
    const ast = parseCondition('output.value != null');
    expect(ast).toEqual({
      type: 'comparison',
      left: { type: 'ref', path: ['output', 'value'] },
      op: '!=',
      right: null,
    });
  });

  it('parses deep references (steps.step_id.output.field)', () => {
    const ast = parseCondition("steps.check.output.label == 'ok'");
    expect(ast).toEqual({
      type: 'comparison',
      left: { type: 'ref', path: ['steps', 'check', 'output', 'label'] },
      op: '==',
      right: 'ok',
    });
  });
});

describe('evaluateCondition', () => {
  const context = {
    output: { label: 'insurance', confidence: 0.95, active: true, value: 'x' },
    document: { page_count: 12, mime_type: 'application/pdf' },
    result: { policy_number: 'ABC-123' },
    steps: { check_insurance: { output: { label: 'insurance' } } },
  };

  it('evaluates simple equality — true', () => {
    const ast = parseCondition("output.label == 'insurance'");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates simple equality — false', () => {
    const ast = parseCondition("output.label == 'medical'");
    expect(evaluateCondition(ast, context)).toBe(false);
  });

  it('evaluates numeric comparison', () => {
    const ast = parseCondition('output.confidence >= 0.8');
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates membership — in', () => {
    const ast = parseCondition("output.label in ['insurance', 'policy']");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates membership — not in', () => {
    const ast = parseCondition("output.label not in ['other', 'medical']");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates contains', () => {
    const ast = parseCondition("output.label contains 'insur'");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates AND', () => {
    const ast = parseCondition("output.label == 'insurance' and output.confidence > 0.5");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates OR', () => {
    const ast = parseCondition("output.label == 'medical' or output.confidence > 0.5");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates NOT', () => {
    const ast = parseCondition("not output.label == 'other'");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates nested parens', () => {
    const ast = parseCondition("(output.label == 'insurance' or output.label == 'medical') and output.confidence > 0.8");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('evaluates deep ref', () => {
    const ast = parseCondition("steps.check_insurance.output.label == 'insurance'");
    expect(evaluateCondition(ast, context)).toBe(true);
  });

  it('returns false for missing ref path', () => {
    const ast = parseCondition("output.nonexistent == 'x'");
    expect(evaluateCondition(ast, context)).toBe(false);
  });

  it('evaluates document.page_count > 50 as false', () => {
    const ast = parseCondition('document.page_count > 50');
    expect(evaluateCondition(ast, context)).toBe(false);
  });

  it('evaluates result.confidence < 0.85 — missing field', () => {
    const ast = parseCondition('result.confidence < 0.85');
    // result.confidence is undefined, so comparison with number fails
    expect(evaluateCondition(ast, context)).toBe(false);
  });
});
