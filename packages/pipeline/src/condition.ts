import type {
  ParsedCondition,
  ConditionRef,
  ConditionValue,
  ComparisonOp,
} from './types.js';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | 'ref'       // dotted identifier  (output.label, document.page_count)
  | 'string'    // 'single-quoted'
  | 'number'    // 42, 3.14
  | 'boolean'   // true / false
  | 'null'      // null
  | 'op'        // ==  !=  >  >=  <  <=
  | 'keyword'   // and  or  not  in  contains
  | 'lparen'    // (
  | 'rparen'    // )
  | 'lbracket'  // [
  | 'rbracket'  // ]
  | 'comma'     // ,
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'contains', 'true', 'false', 'null']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }

    const pos = i;

    // Single-quoted string
    if (input[i] === "'") {
      i++;
      let str = '';
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\' && i + 1 < input.length) {
          i++;
          str += input[i];
        } else {
          str += input[i];
        }
        i++;
      }
      if (i >= input.length) throw new ConditionParseError(`Unterminated string at position ${pos}`, pos);
      i++; // closing quote
      tokens.push({ type: 'string', value: str, pos });
      continue;
    }

    // Two-char operators
    const two = input.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
      tokens.push({ type: 'op', value: two, pos });
      i += 2;
      continue;
    }

    // Single-char operators
    if (input[i] === '>' || input[i] === '<') {
      tokens.push({ type: 'op', value: input[i]!, pos });
      i++;
      continue;
    }

    // Punctuation
    if (input[i] === '(') { tokens.push({ type: 'lparen', value: '(', pos }); i++; continue; }
    if (input[i] === ')') { tokens.push({ type: 'rparen', value: ')', pos }); i++; continue; }
    if (input[i] === '[') { tokens.push({ type: 'lbracket', value: '[', pos }); i++; continue; }
    if (input[i] === ']') { tokens.push({ type: 'rbracket', value: ']', pos }); i++; continue; }
    if (input[i] === ',') { tokens.push({ type: 'comma', value: ',', pos }); i++; continue; }

    // Numbers
    if (/[0-9]/.test(input[i]!) || (input[i] === '-' && i + 1 < input.length && /[0-9]/.test(input[i + 1]!))) {
      let num = '';
      if (input[i] === '-') { num += '-'; i++; }
      while (i < input.length && /[0-9.]/.test(input[i]!)) {
        num += input[i];
        i++;
      }
      tokens.push({ type: 'number', value: num, pos });
      continue;
    }

    // Identifiers / keywords / booleans / null / dotted refs
    if (/[a-zA-Z_]/.test(input[i]!)) {
      let ident = '';
      while (i < input.length && /[a-zA-Z0-9_.]/.test(input[i]!)) {
        ident += input[i];
        i++;
      }

      if (ident === 'true' || ident === 'false') {
        tokens.push({ type: 'boolean', value: ident, pos });
      } else if (ident === 'null') {
        tokens.push({ type: 'null', value: 'null', pos });
      } else if (KEYWORDS.has(ident)) {
        tokens.push({ type: 'keyword', value: ident, pos });
      } else {
        // Dotted ref (output.label, steps.foo.output.bar)
        tokens.push({ type: 'ref', value: ident, pos });
      }
      continue;
    }

    throw new ConditionParseError(`Unexpected character '${input[i]}' at position ${pos}`, pos);
  }

  tokens.push({ type: 'eof', value: '', pos: i });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parse error
// ---------------------------------------------------------------------------

export class ConditionParseError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = 'ConditionParseError';
    this.pos = pos;
  }
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
//
// Grammar (precedence low → high):
//   expr     = or_expr
//   or_expr  = and_expr ('or' and_expr)*
//   and_expr = not_expr ('and' not_expr)*
//   not_expr = 'not' not_expr | primary
//   primary  = '(' expr ')' | comparison
//   comparison = ref (op value | 'in' array | 'not' 'in' array | 'contains' string)
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ParsedCondition {
    const result = this.orExpr();
    if (this.current().type !== 'eof') {
      throw new ConditionParseError(
        `Unexpected token '${this.current().value}' at position ${this.current().pos}`,
        this.current().pos,
      );
    }
    return result;
  }

  private current(): Token {
    return this.tokens[this.pos]!;
  }

  private advance(): Token {
    const tok = this.tokens[this.pos]!;
    this.pos++;
    return tok;
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.current();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new ConditionParseError(
        `Expected ${value ?? type} but got '${tok.value}' at position ${tok.pos}`,
        tok.pos,
      );
    }
    return this.advance();
  }

  // or_expr = and_expr ('or' and_expr)*
  private orExpr(): ParsedCondition {
    let left = this.andExpr();
    while (this.current().type === 'keyword' && this.current().value === 'or') {
      this.advance();
      const right = this.andExpr();
      left = { type: 'or', left, right };
    }
    return left;
  }

  // and_expr = not_expr ('and' not_expr)*
  private andExpr(): ParsedCondition {
    let left = this.notExpr();
    while (this.current().type === 'keyword' && this.current().value === 'and') {
      this.advance();
      const right = this.notExpr();
      left = { type: 'and', left, right };
    }
    return left;
  }

  // not_expr = 'not' not_expr | primary
  private notExpr(): ParsedCondition {
    if (this.current().type === 'keyword' && this.current().value === 'not') {
      this.advance();
      const operand = this.notExpr();
      return { type: 'not', operand };
    }
    return this.primary();
  }

  // primary = '(' expr ')' | comparison
  private primary(): ParsedCondition {
    if (this.current().type === 'lparen') {
      this.advance();
      const expr = this.orExpr();
      this.expect('rparen');
      return expr;
    }
    return this.comparison();
  }

  // comparison = ref (op value | 'in' array | 'not' 'in' array | 'contains' string)
  private comparison(): ParsedCondition {
    const refTok = this.expect('ref');
    const ref: ConditionRef = { type: 'ref', path: refTok.value.split('.') };

    // not in
    if (
      this.current().type === 'keyword' &&
      this.current().value === 'not' &&
      this.pos + 1 < this.tokens.length &&
      this.tokens[this.pos + 1]!.type === 'keyword' &&
      this.tokens[this.pos + 1]!.value === 'in'
    ) {
      this.advance(); // not
      this.advance(); // in
      const arr = this.parseArray();
      return { type: 'membership', left: ref, op: 'not_in', right: arr };
    }

    // in
    if (this.current().type === 'keyword' && this.current().value === 'in') {
      this.advance();
      const arr = this.parseArray();
      return { type: 'membership', left: ref, op: 'in', right: arr };
    }

    // contains
    if (this.current().type === 'keyword' && this.current().value === 'contains') {
      this.advance();
      const val = this.expect('string');
      return { type: 'contains', left: ref, right: val.value };
    }

    // comparison operator
    const opTok = this.expect('op');
    const op = opTok.value as ComparisonOp;
    const value = this.parseValue();
    return { type: 'comparison', left: ref, op, right: value };
  }

  private parseArray(): ConditionValue[] {
    this.expect('lbracket');
    const values: ConditionValue[] = [];
    if (this.current().type !== 'rbracket') {
      values.push(this.parseValue());
      while (this.current().type === 'comma') {
        this.advance();
        values.push(this.parseValue());
      }
    }
    this.expect('rbracket');
    return values;
  }

  private parseValue(): ConditionValue {
    const tok = this.current();
    switch (tok.type) {
      case 'string':
        this.advance();
        return tok.value;
      case 'number':
        this.advance();
        return Number(tok.value);
      case 'boolean':
        this.advance();
        return tok.value === 'true';
      case 'null':
        this.advance();
        return null;
      default:
        throw new ConditionParseError(
          `Expected a value but got '${tok.value}' at position ${tok.pos}`,
          tok.pos,
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — parse
// ---------------------------------------------------------------------------

export function parseCondition(expr: string): ParsedCondition {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  return parser.parse();
}

// ---------------------------------------------------------------------------
// Public API — evaluate
// ---------------------------------------------------------------------------

function resolveRef(path: string[], context: Record<string, unknown>): unknown {
  let current: unknown = context;
  for (const segment of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function compareValues(left: unknown, op: ComparisonOp, right: ConditionValue): boolean {
  if (left == null && right == null) return op === '==' || op === '>=' || op === '<=';
  if (left == null || right == null) return op === '!=';

  switch (op) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '>':  return (left as number) > (right as number);
    case '>=': return (left as number) >= (right as number);
    case '<':  return (left as number) < (right as number);
    case '<=': return (left as number) <= (right as number);
  }
}

export function evaluateCondition(
  condition: ParsedCondition,
  context: Record<string, unknown>,
): boolean {
  switch (condition.type) {
    case 'comparison': {
      const left = resolveRef(condition.left.path, context);
      return compareValues(left, condition.op, condition.right);
    }
    case 'membership': {
      const left = resolveRef(condition.left.path, context);
      const found = condition.right.some((v) => v === left);
      return condition.op === 'in' ? found : !found;
    }
    case 'contains': {
      const left = resolveRef(condition.left.path, context);
      if (typeof left !== 'string') return false;
      return left.includes(condition.right);
    }
    case 'and':
      return evaluateCondition(condition.left, context) && evaluateCondition(condition.right, context);
    case 'or':
      return evaluateCondition(condition.left, context) || evaluateCondition(condition.right, context);
    case 'not':
      return !evaluateCondition(condition.operand, context);
  }
}
