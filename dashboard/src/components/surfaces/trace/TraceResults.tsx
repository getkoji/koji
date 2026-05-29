"use client";

interface TraceResultsProps {
  extractionJson: Record<string, unknown> | null;
  confidenceScoresJson: Record<string, number> | null;
  provenanceJson: Record<
    string,
    | {
        offset?: number;
        length?: number;
        chunk?: string;
        page?: number;
        bbox?: object;
        words?: object[];
      }
    | null
  > | null;
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
  if (!extractionJson || Object.keys(extractionJson).length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-ink-4 font-mono text-[11px]">
        No extraction results
      </div>
    );
  }

  const fields = Object.entries(extractionJson);

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
          const hasProvenance =
            provenanceJson != null && name in provenanceJson && provenanceJson[name] != null;
          const isActive = activeField === name;

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
