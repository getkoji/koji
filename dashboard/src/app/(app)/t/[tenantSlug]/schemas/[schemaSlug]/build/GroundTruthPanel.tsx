"use client";

/**
 * Ground-truth builder — the confirm-vs-correct funnel.
 *
 * After extraction runs on a corpus document the model has *proposed* a value
 * for every field, each carrying provenance (a source location + a resolution
 * "rung" that says how confidently it was placed). This panel turns that into
 * labeling work a non-technical user can do: it surfaces the uncertain fields
 * first (best-guess / no-source ahead of exact locates), and for each field the
 * human either
 *
 *   - confirms the proposed value as-is,
 *   - corrects it by typing, or
 *   - corrects it by drawing a box on the document — the drag resolves to the
 *     text underneath (corpus resolve-region) and snaps the value AND its
 *     geometry (page + bbox + source span) into the label.
 *
 * On save the values go to the corpus ground truth WITH their provenance, so a
 * label stays auditable and region-anchored (see oss-442). The draw layer lives
 * on the parent's DocumentViewer, so this panel reports its `SelectionConfig`
 * upward via `onSelectionConfigChange` rather than rendering the viewer itself.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { MapPin, Check, Crosshair, Loader2, Pencil } from "lucide-react";
import { api } from "@/lib/api";
import {
  sourceConfidence,
  SOURCE_CONFIDENCE_LABEL,
  SOURCE_CONFIDENCE_DESCRIPTION,
  type SourceConfidence,
} from "@/lib/provenance-resolution";
import type { SelectionConfig, RegionSelection, BBoxHighlight } from "@/components/shared/PdfViewer";

/** The provenance span shape this panel reads and writes (a lenient subset of
 *  the engine's ProvenanceSpan — we only touch geometry + the rung). */
interface ProvSpan {
  offset?: number;
  length?: number;
  chunk?: string;
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
  resolution?: string;
  reasoning?: string;
  // Nested spans (arrays/objects) — carried through untouched on save.
  items?: unknown;
  properties?: unknown;
}
type ProvMap = Record<string, ProvSpan | null>;

interface Props {
  schemaSlug: string;
  entryId: string;
  extracted: Record<string, unknown>;
  provenance: ProvMap | undefined;
  /** Report the current selection config up so the parent DocumentViewer can
   *  render the draw layer + snapped echo. `null` while nothing is armed. */
  onSelectionConfigChange: (cfg: SelectionConfig | null) => void;
  /** Ask the parent to highlight a field in the viewer. */
  onFocusField?: (field: string | null) => void;
}

/** Rank buckets worst-first so a human's attention lands on the shaky ones. */
const CONFIDENCE_RANK: Record<SourceConfidence, number> = {
  none: 0,
  approximate: 1,
  exact: 2,
};

const BADGE_STYLE: Record<SourceConfidence, string> = {
  exact: "text-green border-green/30 bg-green/10",
  approximate: "text-yellow-700 border-yellow-600/30 bg-yellow-500/10",
  none: "text-vermillion-2 border-vermillion-2/30 bg-vermillion-3/20",
};

function isScalar(v: unknown): boolean {
  return v == null || typeof v !== "object";
}

function toDisplay(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

export function GroundTruthPanel({
  schemaSlug,
  entryId,
  extracted,
  provenance,
  onSelectionConfigChange,
  onFocusField,
}: Props) {
  // Editable working copies, seeded from the proposal and reset per document.
  const [values, setValues] = useState<Record<string, unknown>>(extracted);
  const [prov, setProv] = useState<ProvMap>(provenance ?? {});
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [armedField, setArmedField] = useState<string | null>(null);
  const [snapped, setSnapped] = useState<BBoxHighlight | null>(null);
  const [resolving, setResolving] = useState(false);
  const [regionHint, setRegionHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Re-seed when the document (or a fresh extraction) changes.
  useEffect(() => {
    setValues(extracted);
    setProv(provenance ?? {});
    setReviewed(new Set());
    setArmedField(null);
    setSnapped(null);
    setRegionHint(null);
    setSaved(false);
  }, [entryId, extracted, provenance]);

  // The armed field, read through a ref so the (stable) region handler reported
  // up to the parent never captures a stale value.
  const armedRef = useRef<string | null>(null);
  useEffect(() => {
    armedRef.current = armedField;
  }, [armedField]);

  const handleRegionSelected = useCallback(
    async (region: RegionSelection) => {
      const field = armedRef.current;
      if (!field) return;
      setResolving(true);
      setRegionHint(null);
      try {
        const r = await api.post<{
          text: string | null;
          words: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
          bbox: { x: number; y: number; w: number; h: number } | null;
        }>(`/api/schemas/${schemaSlug}/corpus/${entryId}/resolve-region`, region);
        if (r.text != null) {
          const bbox = r.bbox ?? region.bbox;
          setValues((prev) => ({ ...prev, [field]: r.text }));
          setProv((prev) => ({
            ...prev,
            // Anchored span: the human pointed at the location, so it renders
            // as an exact highlight and carries the source text verbatim.
            [field]: {
              offset: -1,
              length: 0,
              chunk: r.text ?? undefined,
              page: region.page,
              bbox,
              words: r.words.length > 0 ? r.words : undefined,
              resolution: "anchored",
            },
          }));
          setSnapped({ field, page: region.page, bbox, words: r.words });
          setReviewed((prev) => new Set(prev).add(field));
          setArmedField(null);
        } else {
          setRegionHint("No text under that selection — drag over the value, or type it instead.");
        }
      } catch (err) {
        setRegionHint(err instanceof Error ? err.message : "Could not resolve the selection.");
      } finally {
        setResolving(false);
      }
    },
    [schemaSlug, entryId],
  );

  // Report the selection config to the parent so its DocumentViewer renders the
  // draw layer (when armed) and the snapped echo (which survives disarming).
  useEffect(() => {
    onSelectionConfigChange({
      active: armedField != null,
      onRegionSelected: handleRegionSelected,
      snapped,
    });
    return () => onSelectionConfigChange(null);
  }, [armedField, snapped, handleRegionSelected, onSelectionConfigChange]);

  // Only top-level scalar fields get the confirm/correct treatment; nested
  // arrays/objects are carried through on save but not funnel-controlled here.
  const scalarFields = useMemo(() => {
    const keys = Object.keys(values).filter((k) => isScalar(values[k]));
    return keys
      .map((k) => {
        const span = prov[k] ?? null;
        const hasSource =
          span != null && (span.bbox != null || (span.words?.length ?? 0) > 0 || span.page != null);
        const conf = sourceConfidence(span?.resolution, hasSource);
        return { key: k, conf };
      })
      .sort((a, b) => CONFIDENCE_RANK[a.conf] - CONFIDENCE_RANK[b.conf] || a.key.localeCompare(b.key));
  }, [values, prov]);

  const needsReview = scalarFields.filter((f) => f.conf !== "exact" && !reviewed.has(f.key)).length;

  const editValue = (key: string, next: string) => {
    setValues((prev) => ({ ...prev, [key]: next }));
    setReviewed((prev) => new Set(prev).add(key));
    setSaved(false);
  };

  const toggleArm = (key: string) => {
    setRegionHint(null);
    setArmedField((cur) => (cur === key ? null : key));
    onFocusField?.(key);
  };

  const confirmField = (key: string) => {
    setReviewed((prev) => new Set(prev).add(key));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post(`/api/schemas/${schemaSlug}/corpus/${entryId}/ground-truth`, {
        values,
        provenance: prov,
      });
      setSaved(true);
    } catch (err) {
      console.error("Failed to save ground truth:", err);
      setRegionHint(err instanceof Error ? err.message : "Failed to save ground truth.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink-3">Ground truth</span>
        <span className="text-[10px] font-mono text-ink-4">
          {needsReview > 0 ? `${needsReview} to verify` : "all verified"}
        </span>
      </div>

      <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
        {scalarFields.map(({ key, conf }) => {
          const isArmed = armedField === key;
          const isReviewed = reviewed.has(key);
          return (
            <div key={key} className="px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onFocusField?.(key)}
                  className="font-mono text-[11px] text-ink-4 flex items-center gap-1 min-w-0 hover:text-ink"
                  title="Highlight in document"
                >
                  <MapPin className="w-3 h-3 shrink-0 text-ink-4/60" />
                  <span className="truncate">{key}</span>
                </button>
                <span
                  className={`shrink-0 text-[9px] font-mono px-1.5 py-0.5 rounded-sm border ${BADGE_STYLE[conf]}`}
                  title={SOURCE_CONFIDENCE_DESCRIPTION[conf]}
                >
                  {SOURCE_CONFIDENCE_LABEL[conf]}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1 min-w-0">
                  <Pencil className="w-3 h-3 text-ink-4/40 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={toDisplay(values[key])}
                    onChange={(e) => editValue(key, e.target.value)}
                    placeholder="(empty)"
                    className="w-full pl-7 pr-2 py-1 text-[12px] text-ink bg-cream-2/60 border border-border rounded-sm focus:border-ink focus:outline-none font-mono"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => toggleArm(key)}
                  title="Draw a box on the document to point at the correct value"
                  className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-medium border transition-colors ${
                    isArmed
                      ? "bg-vermillion-2 text-cream border-vermillion-2"
                      : "bg-cream-2 text-ink-3 border-border hover:border-ink hover:text-ink"
                  }`}
                >
                  {resolving && isArmed ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Crosshair className="w-3 h-3" />
                  )}
                  {isArmed ? "Drawing…" : "Point"}
                </button>
                <button
                  type="button"
                  onClick={() => confirmField(key)}
                  title="Confirm this value is correct"
                  className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-sm border transition-colors ${
                    isReviewed
                      ? "bg-green/10 text-green border-green/30"
                      : "bg-cream-2 text-ink-4 border-border hover:border-ink hover:text-ink"
                  }`}
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {armedField && (
        <p className="text-[11px] text-vermillion-2">
          Drag a box around <span className="font-mono">{armedField}</span> in the document.
        </p>
      )}
      {regionHint && <p className="text-[11px] text-vermillion-2">{regionHint}</p>}

      <button
        type="button"
        disabled={saving || saved}
        onClick={handleSave}
        className={`w-full py-2 rounded-sm text-[12px] font-medium transition-colors ${
          saved
            ? "bg-green/10 text-green border border-green/30 cursor-default"
            : "bg-cream-2 text-ink-3 border border-border hover:border-ink hover:text-ink"
        } disabled:opacity-50`}
      >
        {saved ? "Saved as ground truth" : saving ? "Saving…" : "Save as ground truth"}
      </button>
    </div>
  );
}
