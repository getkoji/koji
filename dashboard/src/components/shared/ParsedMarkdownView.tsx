"use client";

import { useEffect, useRef } from "react";

/**
 * Renders parsed document markdown as monospace text with provenance
 * highlights — the "Parsed" view shared by the schema build page and the job
 * document detail page. Clicking a highlighted span toggles the active field
 * (which the PDF viewer also highlights), so the two views stay in sync.
 *
 * `provenance` is the per-field provenance map (offset/length into `markdown`,
 * plus per-item / per-property spans for arrays). Spans are flattened, sorted,
 * and de-overlapped (most specific field key wins) before rendering.
 */

interface ProvenanceSpan {
  offset?: number;
  length?: number;
  items?: Array<{
    offset?: number;
    length?: number;
    properties?: Record<string, { offset?: number; length?: number } | null>;
  } | null>;
}

interface ParsedMarkdownViewProps {
  markdown: string;
  /** Per-field provenance map (offset/length into `markdown`). Loosely typed —
   *  shapes vary by caller; narrowed to ProvenanceSpan internally. */
  provenance?: Record<string, unknown> | null;
  activeField?: string | null;
  onFieldClick?: (field: string | null) => void;
  className?: string;
}

export function ParsedMarkdownView({
  markdown,
  provenance,
  activeField = null,
  onFieldClick,
  className = "",
}: ParsedMarkdownViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the active field's span when it changes. For nested keys
  // ("coverages[0].limit") fall back to parent keys, since not every level has
  // its own provenance span. Scoped to this view's container.
  useEffect(() => {
    if (!activeField) return;
    const root = containerRef.current;
    if (!root) return;
    const timer = setTimeout(() => {
      let key: string | null = activeField;
      while (key) {
        const el = root.querySelector(`[data-provenance-field="${key}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        const dotIdx = key.lastIndexOf(".");
        const bracketIdx = key.lastIndexOf("[");
        const cutAt = Math.max(dotIdx, bracketIdx);
        if (cutAt <= 0) break;
        key = key.slice(0, cutAt);
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [activeField]);

  const md = markdown;
  const prov = provenance ?? {};

  // Flatten all provenance spans including per-item and per-property.
  const allSpans: Array<{ field: string; offset: number; length: number }> = [];
  for (const [field, raw] of Object.entries(prov)) {
    const v = raw as ProvenanceSpan | null;
    if (!v) continue;
    if (v.items && Array.isArray(v.items)) {
      for (let i = 0; i < v.items.length; i++) {
        const item = v.items[i];
        if (!item) continue;
        if (item.properties && typeof item.properties === "object") {
          for (const [propName, pSpan] of Object.entries(item.properties)) {
            if (pSpan && (pSpan.offset ?? -1) >= 0 && (pSpan.length ?? 0) > 0) {
              allSpans.push({ field: `${field}[${i}].${propName}`, offset: pSpan.offset!, length: pSpan.length! });
            }
          }
        }
        if ((item.offset ?? -1) >= 0 && (item.length ?? 0) > 0) {
          allSpans.push({ field: `${field}[${i}]`, offset: item.offset!, length: item.length! });
        }
      }
    }
    if ((v.offset ?? -1) >= 0 && (v.length ?? 0) > 0) {
      allSpans.push({ field, offset: v.offset!, length: v.length! });
    }
  }

  // Sort by offset, then prefer more specific (longer field key) spans.
  allSpans.sort((a, b) => a.offset - b.offset || b.field.length - a.field.length);

  // Deduplicate overlapping spans: keep the most specific one.
  const spans: typeof allSpans = [];
  for (const span of allSpans) {
    const last = spans[spans.length - 1];
    if (last && span.offset < last.offset + last.length) {
      if (span.field.length > last.field.length) {
        spans[spans.length - 1] = span;
      }
      continue;
    }
    spans.push(span);
  }

  const fragments: Array<{ text: string; field?: string }> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.offset > cursor) {
      fragments.push({ text: md.slice(cursor, span.offset) });
    }
    if (span.offset >= cursor) {
      fragments.push({ text: md.slice(span.offset, span.offset + span.length), field: span.field });
      cursor = span.offset + span.length;
    }
  }
  if (cursor < md.length) {
    fragments.push({ text: md.slice(cursor) });
  }

  return (
    <div
      ref={containerRef}
      data-provenance-preview
      className={`border border-border rounded-sm bg-cream overflow-y-auto ${className}`}
    >
      <pre className="p-3 font-mono text-[11px] text-ink-3 whitespace-pre-wrap break-words leading-relaxed">
        {fragments.map((frag, i) =>
          frag.field ? (
            <mark
              key={i}
              data-provenance-field={frag.field}
              className={`rounded-sm px-0.5 cursor-pointer ${
                frag.field === activeField
                  ? "bg-vermillion-3/50 text-vermillion-2 ring-1 ring-vermillion-2/40"
                  : "bg-cream-2 text-ink-3 hover:bg-cream-3"
              }`}
              onClick={() => onFieldClick?.(frag.field === activeField ? null : frag.field!)}
            >
              {frag.text}
            </mark>
          ) : (
            <span key={i}>{frag.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}
