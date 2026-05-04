/**
 * Post-extraction normalization — TypeScript port of services/extract/normalize.py.
 *
 * Schema-declared `normalize:` transforms applied after LLM extraction.
 * All transforms are pure and deterministic. Unknown transform names are
 * recorded as warnings and the value is passed through unchanged.
 */

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface NormApplied {
  field: string;
  transform: string;
}

export interface NormalizationReport {
  applied: NormApplied[];
  warnings: string[];
}

function makeReport(): NormalizationReport {
  return { applied: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Transform implementations
// ---------------------------------------------------------------------------

function trim(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function lowercase(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function uppercase(value: unknown): unknown {
  return typeof value === "string" ? value.toUpperCase() : value;
}

const SLUG_STRIP_RE = /[^a-z0-9]+/g;

function slugify(value: unknown): unknown {
  if (value == null) return null;
  const slug = String(value).toLowerCase().replace(SLUG_STRIP_RE, "_");
  return slug.replace(/^_|_$/g, "");
}

// ── Date normalization ────────────────────────────────────────────────────

const ISO_DATE_RE = /(\d{4})-(\d{1,2})-(\d{1,2})/;
const US_DATE_RE = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/;
const EU_DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/;

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAMES_PATTERN = Object.keys(MONTH_NAMES).join("|");
const VERBOSE_MDY_RE = new RegExp(
  `(?:^|\\b)(${MONTH_NAMES_PATTERN})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,
  "i",
);
const VERBOSE_DMY_RE = new RegExp(
  `(?:^|\\b)(\\d{1,2})\\s+(${MONTH_NAMES_PATTERN}),?\\s+(\\d{4})\\b`,
  "i",
);

function pad2(n: number | string): string {
  return String(n).padStart(2, "0");
}

function expandYear(y: string): string {
  if (y.length === 2) return parseInt(y) < 70 ? `20${y}` : `19${y}`;
  return y;
}

function iso8601(value: unknown, dayfirst = false): unknown {
  if (value == null || typeof value !== "string") return value;
  const s = value.trim();

  // ISO: 2025-01-15
  let m = ISO_DATE_RE.exec(s);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  // Verbose MDY: January 15, 2025
  m = VERBOSE_MDY_RE.exec(s);
  if (m) {
    const mo = MONTH_NAMES[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${pad2(mo)}-${pad2(parseInt(m[2]))}`;
  }

  // Verbose DMY: 15 January 2025
  m = VERBOSE_DMY_RE.exec(s);
  if (m) {
    const mo = MONTH_NAMES[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${pad2(mo)}-${pad2(parseInt(m[1]))}`;
  }

  // Numeric with / or -
  m = US_DATE_RE.exec(s);
  if (m) {
    const a = pad2(m[1]), b = pad2(m[2]);
    const y = expandYear(m[3]);
    const [moStr, dStr] = dayfirst ? [b, a] : [a, b];
    return `${y}-${moStr}-${dStr}`;
  }

  // European DD.MM.YYYY
  m = EU_DATE_RE.exec(s);
  if (m) {
    const d = pad2(m[1]), mo = pad2(m[2]);
    const y = expandYear(m[3]);
    return `${y}-${mo}-${d}`;
  }

  return value;
}

// ── Currency → minor units ────────────────────────────────────────────────

const CURRENCY_STRIP_RE = /[^\d.\-]/g;

function minorUnits(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "boolean") return value;

  let negative = false;
  let amount: number;

  if (typeof value === "string") {
    let s = value.trim();
    if (s.startsWith("(") && s.endsWith(")")) {
      negative = true;
      s = s.slice(1, -1);
    }
    const cleaned = s.replace(CURRENCY_STRIP_RE, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return value;
    amount = parseFloat(cleaned);
    if (isNaN(amount)) return value;
  } else {
    amount = Number(value);
    if (isNaN(amount)) return value;
  }

  let cents = Math.round(amount * 100);
  if (negative) cents = -cents;
  return cents;
}

// ── Phone → E.164 ─────────────────────────────────────────────────────────

function e164(value: unknown): unknown {
  if (value == null || typeof value !== "string") return value;
  const s = value.trim();
  if (!s) return value;
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return value;
  if (hasPlus) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}

// ── US state lookup (for derived_from) ────────────────────────────────────

const US_STATES: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
  "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE",
  "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
  "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA",
  "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC",
};

const STATE_ABBREVS = new Set(Object.values(US_STATES));
const STATE_ABBREV_RE = new RegExp(
  `(?:,\\s*|\\b)(${[...STATE_ABBREVS].join("|")})\\b\\s*(?:\\d{5}|$)`,
  "i",
);

function usStateLookup(text: string, prefer: string = "last"): string | null {
  if (!text) return null;
  const matches = [...text.matchAll(new RegExp(STATE_ABBREV_RE.source, "gi"))];
  if (matches.length > 0) {
    const pick = prefer === "last" ? matches[matches.length - 1] : matches[0];
    return pick[1].toUpperCase();
  }
  const textLower = text.toLowerCase();
  const found: Array<[number, string]> = [];
  for (const [name, abbrev] of Object.entries(US_STATES)) {
    const pos = prefer === "last" ? textLower.lastIndexOf(name) : textLower.indexOf(name);
    if (pos >= 0) found.push([pos, abbrev]);
  }
  if (found.length > 0) {
    found.sort((a, b) => prefer === "last" ? b[0] - a[0] : a[0] - b[0]);
    return found[0][1];
  }
  return null;
}

// ── Locale inference ──────────────────────────────────────────────────────

const LOCALE_SIGNALS: Record<string, [string, string, string]> = {
  "RM": ["MYR", "DD/MM/YYYY", "."],
  "S$": ["SGD", "DD/MM/YYYY", "."],
  "C$": ["CAD", "DD/MM/YYYY", "."],
  "CA$": ["CAD", "DD/MM/YYYY", "."],
  "A$": ["AUD", "DD/MM/YYYY", "."],
  "AU$": ["AUD", "DD/MM/YYYY", "."],
  "\u20AC": ["EUR", "DD/MM/YYYY", ","],
  "\u00A3": ["GBP", "DD/MM/YYYY", "."],
  "\u00A5": ["JPY", "YYYY/MM/DD", "."],
  "\u20B9": ["INR", "DD/MM/YYYY", "."],
};

const COUNTRY_LOCALES: Record<string, [string, string, string]> = {
  "malaysia": ["MYR", "DD/MM/YYYY", "."],
  "singapore": ["SGD", "DD/MM/YYYY", "."],
  "canada": ["CAD", "DD/MM/YYYY", "."],
  "australia": ["AUD", "DD/MM/YYYY", "."],
  "united kingdom": ["GBP", "DD/MM/YYYY", "."],
  "uk": ["GBP", "DD/MM/YYYY", "."],
  "germany": ["EUR", "DD.MM.YYYY", ","],
  "france": ["EUR", "DD/MM/YYYY", ","],
  "japan": ["JPY", "YYYY/MM/DD", "."],
  "india": ["INR", "DD/MM/YYYY", "."],
  "new zealand": ["NZD", "DD/MM/YYYY", "."],
  "brazil": ["BRL", "DD/MM/YYYY", ","],
  "mexico": ["MXN", "DD/MM/YYYY", "."],
};

function inferLocale(
  extracted: Record<string, unknown>,
  scanFields?: string[],
): Record<string, string> {
  let texts: string[];
  if (scanFields) {
    texts = scanFields
      .map((f) => extracted[f])
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map(String);
  } else {
    texts = Object.values(extracted)
      .filter((v): v is string => typeof v === "string" && v.length > 3)
      .map(String);
  }
  const combined = texts.join(" ");
  if (!combined.trim()) return {};

  for (const [symbol, [currency, dateFmt, decSep]] of Object.entries(LOCALE_SIGNALS)) {
    if (combined.includes(symbol)) {
      return { currency, date_format: dateFmt, decimal_separator: decSep };
    }
  }
  const combinedLower = combined.toLowerCase();
  for (const [country, [currency, dateFmt, decSep]] of Object.entries(COUNTRY_LOCALES)) {
    if (combinedLower.includes(country)) {
      return { currency, date_format: dateFmt, decimal_separator: decSep };
    }
  }
  if (STATE_ABBREV_RE.test(combined)) {
    return { currency: "USD", date_format: "MM/DD/YYYY", decimal_separator: "." };
  }
  return {};
}

// ── Levenshtein distance ──────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  if (a.length < b.length) return levenshtein(b, a);
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      curr.push(Math.min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (a[i] !== b[j] ? 1 : 0)));
    }
    prev = curr;
  }
  return prev[b.length];
}

// ---------------------------------------------------------------------------
// Transform registry
// ---------------------------------------------------------------------------

type TransformFn = (value: unknown, ...args: unknown[]) => unknown;

const TRANSFORMS: Record<string, TransformFn> = {
  trim,
  lowercase,
  uppercase,
  slugify,
  iso8601: iso8601 as TransformFn,
  minor_units: minorUnits,
  e164,
};

const DERIVATION_METHODS: Record<string, (text: string, ...args: unknown[]) => string | null> = {
  us_state_lookup: usStateLookup,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function asTransformList(directive: unknown): string[] {
  if (directive == null) return [];
  if (typeof directive === "string") return [directive];
  if (Array.isArray(directive)) return directive.map(String);
  return [];
}

function applyTransforms(
  value: unknown,
  transforms: string[],
  fieldName: string,
  report: NormalizationReport,
  locale?: Record<string, string>,
): unknown {
  const dayfirst = locale?.date_format?.startsWith("DD") ?? false;
  for (const name of transforms) {
    const fn = TRANSFORMS[name];
    if (!fn) {
      report.warnings.push(`${fieldName}: unknown normalize transform '${name}' -- skipped`);
      continue;
    }
    const before = value;
    if (name === "iso8601" && dayfirst) {
      value = (fn as typeof iso8601)(value, true);
    } else {
      value = fn(value);
    }
    if (value !== before) {
      report.applied.push({ field: fieldName, transform: name });
    }
  }
  return value;
}

/**
 * Apply schema-declared `normalize:` transforms to extracted output.
 * Returns new extracted dict + a report. Input is not mutated.
 */
export function normalizeExtracted(
  extracted: unknown,
  schemaDef: Record<string, unknown>,
): [Record<string, unknown>, NormalizationReport] {
  const report = makeReport();
  if (extracted == null || typeof extracted !== "object" || Array.isArray(extracted)) {
    return [(extracted ?? {}) as Record<string, unknown>, report];
  }

  const fieldsSpec = ((schemaDef?.fields as Record<string, unknown>) ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const result: Record<string, unknown> = { ...(extracted as Record<string, unknown>) };

  // Locale inference
  const localeConfig = (schemaDef?.locale as Record<string, unknown>) ?? {};
  const scanFields = localeConfig.infer_from as string[] | undefined;
  const fallback = (localeConfig.fallback as Record<string, string>) ?? {};
  const inferred = Object.keys(localeConfig).length > 0 ? inferLocale(result as Record<string, unknown>, scanFields) : {};
  const effectiveLocale = { ...fallback, ...inferred };
  if (Object.keys(effectiveLocale).length > 0) {
    report.applied.push({ field: "_locale", transform: `inferred ${JSON.stringify(effectiveLocale)}` });
  }

  for (const [fieldName, spec] of Object.entries(fieldsSpec)) {
    if (!(fieldName in result) || !spec || typeof spec !== "object") continue;

    const directive = spec.normalize;
    const transforms = asTransformList(directive);

    let value = result[fieldName];

    // Array of objects: apply item-level normalization
    const itemSpec = typeof spec.items === "object" ? (spec.items as Record<string, unknown>) : null;
    if (
      Array.isArray(value) &&
      itemSpec &&
      typeof (itemSpec as any)?.properties === "object"
    ) {
      const itemSchema = { fields: (itemSpec as any).properties };
      value = value.map((row) => {
        if (row && typeof row === "object" && !Array.isArray(row)) {
          const [newRow] = normalizeExtracted(row, itemSchema);
          return newRow;
        }
        return row;
      });
    }

    if (transforms.length > 0) {
      value = applyTransforms(value, transforms, fieldName, report, effectiveLocale);
    }

    // Enum snapping via Levenshtein
    const options = (spec.options ?? spec.enum) as unknown[];
    if (typeof value === "string" && Array.isArray(options) && options.length > 0) {
      const valueLower = value.trim().toLowerCase();
      if (!options.some((o) => String(o).trim().toLowerCase() === valueLower)) {
        let bestOpt: unknown = null;
        let bestDist = Infinity;
        for (const opt of options) {
          const optStr = String(opt).trim().toLowerCase();
          const dist = levenshtein(valueLower, optStr);
          if (dist < bestDist) {
            bestDist = dist;
            bestOpt = opt;
          }
        }
        const maxLen = Math.max(valueLower.length, 1);
        if (bestOpt != null && bestDist / maxLen < 0.5) {
          report.applied.push({ field: fieldName, transform: `enum snap ${JSON.stringify(value)} -> ${JSON.stringify(bestOpt)}` });
          value = bestOpt;
        }
      }
    }

    result[fieldName] = value;
  }

  // Derived fields
  for (const [fieldName, spec] of Object.entries(fieldsSpec)) {
    if (!spec || typeof spec !== "object") continue;
    const derived = spec.derived_from as Record<string, unknown> | undefined;
    if (!derived || typeof derived !== "object") continue;

    const sourceField = derived.field as string | undefined;
    const methodName = (derived.method ?? derived.transform) as string | undefined;
    if (!methodName) continue;
    const method = DERIVATION_METHODS[methodName];
    if (!method) {
      report.warnings.push(`${fieldName}: unknown derivation method '${methodName}'`);
      continue;
    }

    const current = result[fieldName];
    if (current != null && String(current).trim()) continue;

    let sources: Array<[string, string]>;
    if (sourceField === "*" || !sourceField) {
      sources = Object.entries(result)
        .filter(([, v]) => typeof v === "string" && v.length > 5)
        .map(([k, v]) => [k, v as string]);
    } else {
      const v = result[sourceField];
      sources = typeof v === "string" && v ? [[sourceField, v]] : [];
    }

    const methodKwargs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(derived)) {
      if (k !== "field" && k !== "method" && k !== "transform") methodKwargs[k] = v;
    }

    for (const [srcName, srcValue] of sources) {
      const derivedVal = method(srcValue, methodKwargs.prefer as string);
      if (derivedVal) {
        result[fieldName] = derivedVal;
        report.applied.push({ field: fieldName, transform: `derived via ${methodName} from ${srcName}` });
        break;
      }
    }
  }

  // Resolve fields — interpolate other field values to look up a field by name.
  // Example: resolve: "insurer_{gl_insurer_letter}" with gl_insurer_letter="A"
  // resolves to the value of the "insurer_a" field.
  for (const [fieldName, spec] of Object.entries(fieldsSpec)) {
    if (!spec || typeof spec !== "object") continue;
    const resolveTemplate = spec.resolve as string | undefined;
    if (!resolveTemplate) continue;

    // Don't overwrite if already has a value
    const current = result[fieldName];
    if (current != null && String(current).trim()) continue;

    // Interpolate {field_name} references in the template
    const resolved = resolveTemplate.replace(/\{(\w+)\}/g, (_, ref) => {
      const val = result[ref];
      return val != null ? String(val).toLowerCase() : "";
    });

    // Look up the resolved field name in the extracted results
    if (resolved && resolved in result) {
      const resolvedValue = result[resolved];
      if (resolvedValue != null) {
        result[fieldName] = resolvedValue;
        report.applied.push({ field: fieldName, transform: `resolve "${resolveTemplate}" → ${resolved}` });
      }
    }
  }

  return [result, report];
}
