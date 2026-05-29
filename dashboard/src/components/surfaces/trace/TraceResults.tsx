"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

interface ProvenanceItem {
  offset?: number;
  length?: number;
  chunk?: string;
  page?: number;
  bbox?: object;
  words?: object[];
  items?: ProvenanceItem[];
}

interface TraceResultsProps {
  extractionJson: Record<string, unknown> | null;
  confidenceScoresJson: Record<string, number> | null;
  provenanceJson: Record<string, ProvenanceItem | null> | null;
  activeField: string | null;
  onFieldClick: (field: string | null) => void;
}

export function TraceResults({
  extractionJson,
  confidenceScoresJson,
  provenanceJson,
  activeField,
  onFieldClick,
}: TraceResultsProps) {
  const [expandedArrays, setExpandedArrays] = useState<Set<string>>(new Set());

  if (!extractionJson || Object.keys(extractionJson).length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-ink-4 font-mono text-[11px]">
        No extraction results
      </div>
    );
  }

  const fields = Object.entries(extractionJson);

  const toggleExpand = (field: string) => {
    setExpandedArrays((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
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
          const hasProvenance = prov != null;
          const isArrayOfObjects = isObjectArray(value);
          const isExpanded = expandedArrays.has(name);
          const isActive = activeField === name;

          if (isArrayOfObjects) {
            const items = value as Record<string, unknown>[];
            return (
              <div key={name}>
                {/* Parent array row */}
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
                      className={`w-3 h-3 shrink-0 text-ink-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    />
                    {name}
                    {hasProvenance && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-vermillion-2 shrink-0" />
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-ink-3 shrink-0">
                    {items.length} item{items.length !== 1 ? "s" : ""}
                  </span>
                  {confidence !== null && (
                    <span
                      className={`font-mono text-[10px] font-medium tabular-nums shrink-0 ${confidenceColor(confidence)}`}
                    >
                      {Math.round(confidence * 100)}%
                    </span>
                  )}
                </button>

                {/* Expanded item rows */}
                {isExpanded &&
                  items.map((item, idx) => {
                    const itemKey = `${name}[${idx}]`;
                    const itemActive = activeField === itemKey;
                    const itemProv = prov?.items?.[idx];
                    const hasItemProv = itemProv != null;
                    const itemExpanded = expandedArrays.has(itemKey);
                    const entries = Object.entries(item).filter(([, v]) => v != null);

                    return (
                      <div key={itemKey}>
                        {/* Item header row */}
                        <button
                          type="button"
                          onClick={() => {
                            toggleExpand(itemKey);
                            onFieldClick(itemActive ? null : itemKey);
                          }}
                          className={`w-full text-left px-4 pl-8 py-1.5 border-b border-dotted border-border text-[11px] cursor-pointer transition-colors hover:bg-cream-2 ${
                            itemActive
                              ? "border-l-[3px] border-l-vermillion-2 pl-[calc(2rem-3px)] bg-vermillion-3/10"
                              : "border-l-[3px] border-l-transparent"
                          }`}
                        >
                          <div className="flex items-baseline gap-2">
                            <ChevronRight
                              className={`w-2.5 h-2.5 shrink-0 text-ink-4 transition-transform ${itemExpanded ? "rotate-90" : ""}`}
                            />
                            <span className="font-mono text-[10px] text-ink-4 shrink-0 tabular-nums">
                              [{idx}]
                            </span>
                            <span className="font-mono text-[10.5px] text-ink-2 truncate min-w-0 flex items-center gap-1.5">
                              {hasItemProv && (
                                <span className="inline-block w-1 h-1 rounded-full bg-vermillion-2 shrink-0" />
                              )}
                              {summarizeObject(item)}
                            </span>
                          </div>
                        </button>

                        {/* Expanded property rows */}
                        {itemExpanded &&
                          entries.map(([propName, propValue]) => (
                            <button
                              key={`${itemKey}.${propName}`}
                              type="button"
                              onClick={() => onFieldClick(itemActive ? null : itemKey)}
                              className={`w-full text-left pl-14 pr-4 py-1 border-b border-dotted border-border/50 text-[10.5px] cursor-pointer transition-colors hover:bg-cream-2 ${
                                itemActive
                                  ? "bg-vermillion-3/5"
                                  : ""
                              }`}
                              style={{ gridTemplateColumns: "auto 1fr" }}
                            >
                              <div className="flex items-baseline gap-2 min-w-0">
                                <span className="font-mono text-[10px] text-ink-4 shrink-0">
                                  {propName}
                                </span>
                                <span className="font-mono text-[10.5px] text-ink-2 truncate min-w-0">
                                  {typeof propValue === "object" ? JSON.stringify(propValue) : String(propValue)}
                                </span>
                              </div>
                            </button>
                          ))}
                      </div>
                    );
                  })}
              </div>
            );
          }

          // Scalar / non-object-array field — unchanged
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
                {hasProvenance && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-vermillion-2 shrink-0" />
                )}
              </span>
              <span className="font-mono text-[11px] text-ink-2 truncate min-w-0 max-w-[200px] text-right">
                {formatValue(value)}
              </span>
              {confidence !== null && (
                <span
                  className={`font-mono text-[10px] font-medium tabular-nums shrink-0 ${confidenceColor(confidence)}`}
                >
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

/** Check if value is an array of objects (not primitives). */
function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => v != null && typeof v === "object" && !Array.isArray(v))
  );
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

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "string") return value || "\u2014";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const summary = JSON.stringify(value);
    return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
  }
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
