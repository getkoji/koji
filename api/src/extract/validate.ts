/**
 * Post-extract validation — TypeScript port of services/extract/validate.py.
 *
 * Schema-declared validation rules run after normalization.
 * Each rule type is a handler that checks extracted data and appends
 * issues to a report. Passing rules emit nothing.
 */

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  rule: string;
  field: string | null;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

function makeReport(): ValidationReport {
  return { ok: true, issues: [] };
}

function fail(report: ValidationReport, rule: string, field: string | null, message: string): void {
  report.ok = false;
  report.issues.push({ rule, field, message });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMissing(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return true;
  return false;
}

/** Walk a dotted path. Arrays are expanded: "line_items.total" returns
 *  [row.total for row in data.line_items]. */
function getPath(data: unknown, path: string): unknown[] {
  if (!path) return [data];
  const parts = path.split(".");
  let current: unknown[] = [data];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        const obj = node as Record<string, unknown>;
        if (part in obj) next.push(obj[part]);
      } else if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const obj = item as Record<string, unknown>;
            if (part in obj) next.push(obj[part]);
          }
        }
      }
    }
    current = next;
  }
  return current;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.\-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

type RuleHandler = (params: unknown, data: Record<string, unknown>, report: ValidationReport) => void;

function checkRequired(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  const fields = Array.isArray(params) ? params : [];
  for (const fname of fields) {
    if (isMissing(data[fname])) {
      fail(report, "required", fname, `required field '${fname}' is missing`);
    }
  }
}

function checkNotEmpty(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  const fields = Array.isArray(params) ? params : [];
  for (const fname of fields) {
    const value = data[fname];
    if (value == null || (Array.isArray(value) && value.length === 0) ||
        (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)) {
      fail(report, "not_empty", fname, `field '${fname}' must not be empty`);
    }
  }
}

function checkEnumIn(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const p = params as Record<string, unknown>;
  const fname = p.field as string;
  const allowed = p.allowed as unknown[];
  if (!fname || !Array.isArray(allowed)) return;
  const value = data[fname];
  if (value == null) return;
  if (!allowed.includes(value)) {
    const allowedStr = allowed.map(String).join(", ");
    fail(report, "enum_in", fname, `value ${JSON.stringify(value)} not in allowed set [${allowedStr}]`);
  }
}

function checkDateOrder(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  const fields = Array.isArray(params) ? params : [];
  if (fields.length < 2) return;
  const values: Array<[string, string]> = [];
  for (const fname of fields) {
    const v = data[fname];
    if (typeof v !== "string" || !v) return;
    values.push([fname, v]);
  }
  for (let i = 0; i < values.length - 1; i++) {
    const [aName, a] = values[i];
    const [bName, b] = values[i + 1];
    if (a > b) {
      fail(report, "date_order", bName, `'${aName}' (${a}) must not be after '${bName}' (${b})`);
      return;
    }
  }
}

function checkSumEquals(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const p = params as Record<string, unknown>;
  const fname = p.field as string;
  const sumPath = p.sum_of as string;
  const tolerance = Number(p.tolerance ?? 0.01);
  if (!fname || !sumPath) return;
  const expected = coerceNumber(data[fname]);
  if (expected == null) return;
  const parts = getPath(data, sumPath);
  const numeric = parts.map(coerceNumber).filter((n): n is number => n != null);
  if (numeric.length === 0) return;
  const actual = numeric.reduce((a, b) => a + b, 0);
  if (Math.abs(expected - actual) > tolerance) {
    fail(report, "sum_equals", fname, `${fname}=${expected} but sum of ${sumPath}=${actual} (tolerance ${tolerance})`);
  }
}

function checkFieldSum(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const p = params as Record<string, unknown>;
  const fname = p.field as string;
  const addends = p.addends as string[];
  const tolerance = Number(p.tolerance ?? 0.01);
  const autoCorrect = Boolean(p.auto_correct ?? false);
  if (!fname || !Array.isArray(addends) || addends.length < 2) return;
  const expected = coerceNumber(data[fname]);
  if (expected == null) return;
  const parts = addends.map((a) => coerceNumber(data[a]));
  if (parts.some((p) => p == null)) return;
  const computed = (parts as number[]).reduce((a, b) => a + b, 0);
  if (Math.abs(expected - computed) <= tolerance) return;
  if (autoCorrect) {
    data[fname] = Math.round(computed * 100) / 100;
    fail(report, "field_sum", fname, `corrected ${fname}: was ${expected}, set to ${computed} (sum of ${addends.join(", ")})`);
  } else {
    fail(report, "field_sum", fname, `${fname}=${expected} but sum of [${addends.join(", ")}]=${computed} (tolerance ${tolerance})`);
  }
}

function checkMinWords(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const p = params as Record<string, unknown>;
  const fname = p.field as string;
  const minCount = Number(p.min ?? 5);
  if (!fname) return;
  const value = data[fname];
  if (typeof value !== "string") return;
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  if (wordCount < minCount) {
    fail(report, "min_words", fname, `nulled: ${wordCount} words (min ${minCount}) -- likely a classification code, not a narrative`);
    data[fname] = null;
  }
}

function checkRegex(params: unknown, data: Record<string, unknown>, report: ValidationReport): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const p = params as Record<string, unknown>;
  const fname = p.field as string;
  const pattern = p.pattern as string;
  if (!fname || !pattern) return;
  const value = data[fname];
  if (value == null) return;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    fail(report, "regex", fname, `invalid pattern: ${e}`);
    return;
  }
  if (!regex.test(String(value))) {
    fail(report, "regex", fname, `value ${JSON.stringify(value)} does not match /${pattern}/`);
  }
}

const RULES: Record<string, RuleHandler> = {
  required: checkRequired,
  not_empty: checkNotEmpty,
  enum_in: checkEnumIn,
  date_order: checkDateOrder,
  sum_equals: checkSumEquals,
  field_sum: checkFieldSum,
  min_words: checkMinWords,
  regex: checkRegex,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run all schema-declared validation rules against extracted data.
 * Returns a report with ok=true when no rules fail.
 */
export function validateExtracted(
  extracted: unknown,
  schemaDef: Record<string, unknown>,
): ValidationReport {
  const report = makeReport();
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return report;
  const data = extracted as Record<string, unknown>;

  const rules = schemaDef?.validation;
  if (!Array.isArray(rules)) return report;

  for (const ruleEntry of rules) {
    if (!ruleEntry || typeof ruleEntry !== "object" || Array.isArray(ruleEntry)) {
      fail(report, "malformed", null, "validation rule must be a single-key dict");
      continue;
    }
    const entries = Object.entries(ruleEntry as Record<string, unknown>);
    if (entries.length !== 1) {
      fail(report, "malformed", null, "validation rule must be a single-key dict");
      continue;
    }
    const [ruleName, params] = entries[0];
    const handler = RULES[ruleName];
    if (!handler) {
      fail(report, "unknown", null, `unknown validation rule '${ruleName}'`);
      continue;
    }
    handler(params, data, report);
  }

  return report;
}
