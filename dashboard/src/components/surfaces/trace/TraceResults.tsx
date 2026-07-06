"use client";

import { useState } from "react";
import { ChevronRight, Pencil } from "lucide-react";
import { keepRawView } from "@/lib/keep-raw";
import {
  sourceConfidence,
  SOURCE_CONFIDENCE_DESCRIPTION,
  SOURCE_CONFIDENCE_LABEL,
} from "@/lib/provenance-resolution";

interface ProvenanceItem {
  offset?: number;
  length?: number;
  chunk?: string;
  page?: number;
  bbox?: object;
  words?: object[];
  resolution?: string;
  items?: ProvenanceItem[];
  properties?: Record<string, ProvenanceItem | null>;
}

interface TraceResultsProps {
  extractionJson: Record<string, unknown> | null;
  confidenceScoresJson: Record<string, number> | null;
  provenanceJson: Record<string, ProvenanceItem | null> | null;
  activeField: string | null;
  onFieldClick: (field: string | null) => void;
  /**
   * When provided, top-level scalar fields grow a hover pencil that starts a
   * manual correction (document detail's correct-field flow). Nested paths
   * aren't correctable in v1 — the corrections endpoint addresses top-level
   * extraction keys.
   */
  onCorrectField?: (field: string, currentValue: unknown) => void;
}

export function TraceResults({
  extractionJson,
  confidenceScoresJson,
  provenanceJson,
  activeField,
  onFieldClick,
  onCorrectField,
}: TraceResultsProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!extractionJson || Object.keys(extractionJson).length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-ink-4 font-mono text-[11px]">
        No extraction results
      </div>
    );
  }

  const { entries: fields, rawByField } = keepRawView(extractionJson);

  // Only surface source indicators when provenance was actually computed for
  // this document. When the whole map is absent we can't say anything honest
  // about where a field came from, so show nothing (rather than "no source"
  // on every field).
  const provenanceAvailable = provenanceJson != null;

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-border shrink-0 bg-cream">
        <span className="font-mono text-[9px] font-medium tracking-[0.14em] uppercase text-ink-4">
          Extraction results
        </span>
        <span className="font-mono text-[10px] text-ink-3">
          {fields.length} field{fields.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {fields.map(([name, value]) => {
          const confidence = confidenceScoresJson?.[name] ?? null;
          const prov = provenanceJson?.[name];
          const isExpandable = isComplex(value);
          const isActive = activeField === name;

          if (isExpandable) {
            const isOpen = expanded.has(name);
            return (
              <div key={name}>
                <button
                  type="button"
                  onClick={() => toggleExpand(name)}
                  className={`w-full text-left grid items-baseline gap-2.5 px-4 py-2 border-b border-dotted border-border text-[11.5px] cursor-pointer transition-colors hover:bg-cream-2 ${
                    isActive
                      ? "border-l-[3px] border-l-vermillion-2 pl-[calc(1rem-3px)] bg-cream-2"
                      : "border-l-[3px] border-l-transparent"
                  }`}
                  style={{ gridTemplateColumns: "1fr auto auto" }}
                >
                  <span className="font-mono text-[11px] text-ink font-medium truncate min-w-0 flex items-center gap-1.5">
                    <ChevronRight
                      className={`w-3 h-3 shrink-0 text-ink-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
                    />
                    {name}
                    {provenanceAvailable && <SourceIndicator prov={prov} />}
                  </span>
                  <span className="font-mono text-[11px] text-ink-3 shrink-0">
                    {summarizeType(value)}
                  </span>
                  {confidence !== null && (
                    <span className={`font-mono text-[10px] font-medium tabular-nums shrink-0 ${confidenceColor(confidence)}`}>
                      {Math.round(confidence * 100)}%
                    </span>
                  )}
                </button>
                {isOpen && (
                  <NestedValue
                    value={value}
                    keyPath={name}
                    depth={1}
                    prov={prov}
                    activeField={activeField}
                    onFieldClick={onFieldClick}
                    expanded={expanded}
                    toggleExpand={toggleExpand}
                  />
                )}
              </div>
            );
          }

          // Scalar field
          return (
            <button
              key={name}
              type="button"
              onClick={() => onFieldClick(isActive ? null : name)}
              className={`w-full text-left grid items-baseline gap-2.5 px-4 py-2 border-b border-dotted border-border text-[11.5px] cursor-pointer transition-colors hover:bg-cream-2 ${
                isActive
                  ? "border-l-[3px] border-l-vermillion-2 pl-[calc(1rem-3px)] bg-cream-2"
                  : "border-l-[3px] border-l-transparent"
              }`}
              style={{ gridTemplateColumns: "1fr auto auto" }}
            >
              <span className="font-mono text-[11px] text-ink font-medium truncate min-w-0 flex items-center gap-1.5">
                {name}
                {provenanceAvailable && <SourceIndicator prov={prov} />}
                {onCorrectField && (
                  <span
                    role="button"
                    tabIndex={0}
                    data-testid={`correct-${name}`}
                    title="Correct this value"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCorrectField(name, value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        onCorrectField(name, value);
                      }
                    }}
                    className="shrink-0 p-0.5 rounded-sm text-ink-4 hover:text-ink hover:bg-cream-3 transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                  </span>
                )}
              </span>
              <span className="flex flex-col items-end min-w-0 max-w-[200px]">
                <span className="font-mono text-[11px] text-ink-2 truncate min-w-0 text-right">
                  {formatScalar(value)}
                </span>
                {rawByField[name] != null && (
                  <span className="font-mono text-[10px] text-ink-4 truncate min-w-0 text-right" title={rawByField[name]}>
                    {rawByField[name]}
                  </span>
                )}
              </span>
              {confidence !== null && (
                <span className={`font-mono text-[10px] font-medium tabular-nums shrink-0 ${confidenceColor(confidence)}`}>
                  {Math.round(confidence * 100)}%
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recursive nested value renderer
// ---------------------------------------------------------------------------

const INDENT_PX = 24; // px per depth level

function NestedValue({
  value,
  keyPath,
  depth,
  prov,
  activeField,
  onFieldClick,
  expanded,
  toggleExpand,
}: {
  value: unknown;
  keyPath: string;
  depth: number;
  prov: ProvenanceItem | null | undefined;
  activeField: string | null;
  onFieldClick: (field: string | null) => void;
  expanded: Set<string>;
  toggleExpand: (key: string) => void;
}) {
  const pl = 16 + depth * INDENT_PX;

  // Array: render each item
  if (Array.isArray(value)) {
    return (
      <>
        {value.map((item, idx) => {
          const itemKey = `${keyPath}[${idx}]`;
          const itemProv = prov?.items?.[idx];
          const itemExpandable = isComplex(item);
          const itemActive = activeField === itemKey;
          const isOpen = expanded.has(itemKey);

          if (itemExpandable) {
            return (
              <div key={itemKey}>
                <button
                  type="button"
                  onClick={() => { toggleExpand(itemKey); onFieldClick(itemKey); }}
                  className={`w-full text-left py-1.5 border-b border-dotted border-border text-[11px] cursor-pointer transition-colors hover:bg-cream-2 ${
                    itemActive ? "border-l-[3px] border-l-vermillion-2 bg-vermillion-3/10" : "border-l-[3px] border-l-transparent"
                  }`}
                  style={{ paddingLeft: itemActive ? pl - 3 : pl }}
                >
                  <div className="flex items-baseline gap-2">
                    <ChevronRight className={`w-2.5 h-2.5 shrink-0 text-ink-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    <span className="font-mono text-[10px] text-ink-4 shrink-0 tabular-nums">[{idx}]</span>
                    <span className="font-mono text-[10.5px] text-ink-2 truncate min-w-0 flex items-center gap-1.5">
                      {itemProv && <SourceIndicator prov={itemProv} small />}
                      {typeof item === "object" && !Array.isArray(item) ? summarizeObject(item as Record<string, unknown>) : summarizeType(item)}
                    </span>
                  </div>
                </button>
                {isOpen && (
                  <NestedValue
                    value={item}
                    keyPath={itemKey}
                    depth={depth + 1}
                    prov={itemProv}
                    activeField={activeField}
                    onFieldClick={onFieldClick}
                    expanded={expanded}
                    toggleExpand={toggleExpand}
                  />
                )}
              </div>
            );
          }

          // Scalar array item
          return (
            <button
              key={itemKey}
              type="button"
              onClick={() => onFieldClick(itemKey)}
              className={`w-full text-left py-1 border-b border-dotted border-border/50 text-[10.5px] cursor-pointer transition-colors hover:bg-cream-2 ${
                itemActive ? "bg-vermillion-3/10 border-l-[3px] border-l-vermillion-2" : "border-l-[3px] border-l-transparent"
              }`}
              style={{ paddingLeft: itemActive ? pl - 3 : pl }}
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="font-mono text-[10px] text-ink-4 shrink-0 tabular-nums">[{idx}]</span>
                <span className="font-mono text-[10.5px] text-ink-2 truncate min-w-0">{formatScalar(item)}</span>
              </div>
            </button>
          );
        })}
      </>
    );
  }

  // Object: render each property
  if (value != null && typeof value === "object") {
    const { entries, rawByField } = keepRawView(value);
    return (
      <>
        {entries.map(([propName, propValue]) => {
          const propKey = `${keyPath}.${propName}`;
          const propProv = prov?.properties?.[propName];
          const propExpandable = isComplex(propValue);
          const propActive = activeField === propKey;
          const isOpen = expanded.has(propKey);

          if (propExpandable) {
            return (
              <div key={propKey}>
                <button
                  type="button"
                  onClick={() => { toggleExpand(propKey); onFieldClick(propKey); }}
                  className={`w-full text-left py-1 border-b border-dotted border-border/50 text-[10.5px] cursor-pointer transition-colors hover:bg-cream-2 ${
                    propActive ? "bg-vermillion-3/10 border-l-[3px] border-l-vermillion-2" : "border-l-[3px] border-l-transparent"
                  }`}
                  style={{ paddingLeft: propActive ? pl - 3 : pl }}
                >
                  <div className="flex items-baseline gap-2 min-w-0">
                    <ChevronRight className={`w-2.5 h-2.5 shrink-0 text-ink-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    <span className="font-mono text-[10px] text-ink-4 shrink-0">{propName}</span>
                    <span className="font-mono text-[10.5px] text-ink-3 shrink-0">{summarizeType(propValue)}</span>
                  </div>
                </button>
                {isOpen && (
                  <NestedValue
                    value={propValue}
                    keyPath={propKey}
                    depth={depth + 1}
                    prov={propProv}
                    activeField={activeField}
                    onFieldClick={onFieldClick}
                    expanded={expanded}
                    toggleExpand={toggleExpand}
                  />
                )}
              </div>
            );
          }

          // Scalar property
          return (
            <button
              key={propKey}
              type="button"
              onClick={() => onFieldClick(propKey)}
              className={`w-full text-left py-1 border-b border-dotted border-border/50 text-[10.5px] cursor-pointer transition-colors hover:bg-cream-2 ${
                propActive ? "bg-vermillion-3/10 border-l-[3px] border-l-vermillion-2" : "border-l-[3px] border-l-transparent"
              }`}
              style={{ paddingLeft: propActive ? pl - 3 : pl }}
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="font-mono text-[10px] text-ink-4 shrink-0">{propName}</span>
                <span className="flex flex-col min-w-0">
                  <span className="font-mono text-[10.5px] text-ink-2 truncate min-w-0">{formatScalar(propValue)}</span>
                  {rawByField[propName] != null && (
                    <span className="font-mono text-[9.5px] text-ink-4 truncate min-w-0" title={rawByField[propName]}>
                      {rawByField[propName]}
                    </span>
                  )}
                </span>
              </div>
            </button>
          );
        })}
      </>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Per-field source indicator. Translates a provenance span's resolution rung
 * into an honest affordance:
 *   - exact       → solid dot ("Exact source" on hover)
 *   - approximate → hollow dot ("Best guess" — the location may be off)
 *   - none        → an inline "no source located" label, so a field whose
 *                   value couldn't be traced back to the document isn't
 *                   silently indistinguishable from one that could.
 */
function SourceIndicator({
  prov,
  small,
}: {
  prov: ProvenanceItem | null | undefined;
  small?: boolean;
}) {
  const hasSource = !!(
    prov &&
    (prov.bbox ||
      (prov.words && prov.words.length > 0) ||
      prov.page != null ||
      (prov.offset != null && prov.offset >= 0))
  );
  const confidence = sourceConfidence(prov?.resolution, hasSource);

  if (confidence === "none") {
    return (
      <span
        className="shrink-0 font-mono text-[9px] italic text-ink-4"
        title={SOURCE_CONFIDENCE_DESCRIPTION.none}
      >
        {SOURCE_CONFIDENCE_LABEL.none.toLowerCase()}
      </span>
    );
  }

  const approx = confidence === "approximate";
  const size = small ? "w-1 h-1" : "w-1.5 h-1.5";
  return (
    <span
      title={approx ? SOURCE_CONFIDENCE_DESCRIPTION.approximate : SOURCE_CONFIDENCE_DESCRIPTION.exact}
      className={`inline-block ${size} rounded-full shrink-0 ${
        approx ? "border border-vermillion-2 bg-transparent" : "bg-vermillion-2"
      }`}
    />
  );
}

/** Is this value expandable (array or object)? */
function isComplex(value: unknown): boolean {
  if (Array.isArray(value) && value.length > 0) return true;
  if (value != null && typeof value === "object" && Object.keys(value).length > 0) return true;
  return false;
}

/** Short type summary: "3 items", "object", etc. */
function summarizeType(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length !== 1 ? "s" : ""}`;
  if (value != null && typeof value === "object") {
    const keys = Object.keys(value);
    return `${keys.length} field${keys.length !== 1 ? "s" : ""}`;
  }
  return formatScalar(value);
}

/** Summarize an object as "key: val, key: val" — truncated. */
function summarizeObject(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}: ${valStr}`);
  }
  const summary = parts.join(", ");
  return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary || "\u2014";
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "string") return value || "\u2014";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const summary = JSON.stringify(value);
    return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
  }
  return String(value);
}

function confidenceColor(confidence: number): string {
  const pct = confidence * 100;
  if (pct >= 80) return "text-green";
  if (pct >= 30) return "text-ink-4";
  return "text-vermillion-2";
}
