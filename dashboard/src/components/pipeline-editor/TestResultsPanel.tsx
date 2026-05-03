"use client";

export interface StepTestResult {
  stepId: string;
  stepType: string;
  status: "completed" | "failed" | "skipped";
  output: Record<string, unknown>;
  durationMs: number;
  costUsd: number;
  error?: string;
  edgeEvaluations: Array<{
    to: string;
    condition?: string;
    matched: boolean;
  }>;
}

interface TestResultsPanelProps {
  result: StepTestResult;
  onClose: () => void;
}

export function TestResultsPanel({ result, onClose }: TestResultsPanelProps) {
  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-[380px] overflow-y-auto z-10"
      style={{
        background: "#F4EEE2",
        borderLeft: "1px solid #E8E0D0",
        padding: "20px",
        fontFamily: "'Instrument Sans', sans-serif",
        boxShadow: "-4px 0 12px rgba(0,0,0,0.05)",
      }}
    >
      <div className="flex justify-between items-center mb-4">
        <div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "10px",
            fontWeight: 500,
            letterSpacing: "0.12em",
            textTransform: "uppercase" as const,
            color: result.status === "completed" ? "#2D8A4E" : result.status === "failed" ? "#DC2626" : "#8A847B",
          }}>
            {result.stepType} · {result.status}
          </div>
          <h3 style={{
            fontFamily: "'Fraunces', serif",
            fontSize: "16px",
            fontWeight: 500,
            margin: "4px 0 0",
            color: "#171410",
          }}>
            {result.stepId}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="text-[#8A847B] hover:text-[#171410] bg-transparent border-none cursor-pointer text-[18px]"
        >
          ×
        </button>
      </div>

      <div className="flex gap-4 mb-4 pb-4" style={{ borderBottom: "1px solid #E8E0D0" }}>
        <div>
          <div style={metaLabelStyle}>Duration</div>
          <div style={metaValueStyle}>{(result.durationMs / 1000).toFixed(2)}s</div>
        </div>
        <div>
          <div style={metaLabelStyle}>Cost</div>
          <div style={metaValueStyle}>${result.costUsd.toFixed(4)}</div>
        </div>
      </div>

      {result.error ? (
        <div className="mb-4 p-3 rounded" style={{
          background: "rgba(220, 38, 38, 0.06)",
          border: "1px solid rgba(220, 38, 38, 0.15)",
          fontSize: "12px",
          color: "#DC2626",
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {result.error}
        </div>
      ) : null}

      {result.stepType === "classify" ? <ClassifyResults output={result.output} /> : null}
      {result.stepType === "extract" ? <ExtractResults output={result.output} /> : null}
      {result.stepType === "tag" ? <TagResults output={result.output} /> : null}
      {result.stepType === "filter" ? (
        <div>
          <div style={sectionLabelStyle}>Filter</div>
          <div style={{ fontSize: "14px", fontWeight: 500, color: result.output.passed ? "#2D8A4E" : "#DC2626" }}>
            {result.output.passed ? "✓ Passed" : "✗ Blocked"}
          </div>
        </div>
      ) : null}
      {result.stepType === "webhook" ? (
        <div>
          <div style={sectionLabelStyle}>Webhook</div>
          <div style={{ fontSize: "12px", color: "#8A847B" }}>
            {result.output.skipped ? "Skipped in test mode" : `Status: ${result.output.status_code || "sent"}`}
          </div>
        </div>
      ) : null}
      {result.stepType === "gate" ? (
        <div>
          <div style={sectionLabelStyle}>Gate (HITL)</div>
          <div style={{ fontSize: "12px", color: "#8A847B" }}>
            {result.output.auto_approved ? "Auto-approved in test mode" : "Pending review"}
          </div>
        </div>
      ) : null}
      {result.stepType === "resolve_references" ? (
        <div>
          <div style={sectionLabelStyle}>References Detected</div>
          {(result.output.references as Array<Record<string, unknown>>)?.length > 0 ? (
            <div className="flex flex-col gap-2">
              {(result.output.references as Array<Record<string, unknown>>).map((ref, i) => (
                <div key={i} className="p-2 rounded" style={{ border: "1px solid #E8E0D0", fontSize: "12px" }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#C33520", marginBottom: "2px" }}>
                    {String(ref.text)}
                  </div>
                  <div style={{ fontSize: "10px", color: "#8A847B" }}>
                    in chunk: {String(ref.source_chunk)} · {ref.resolved ? "resolved" : "unresolved"}
                  </div>
                  {ref.target_filename ? (
                    <div style={{ fontSize: "10px", color: "#2D8A4E" }}>→ {String(ref.target_filename)}{ref.target_section ? ` § ${String(ref.target_section)}` : ""}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: "12px", color: "#8A847B", fontStyle: "italic" }}>No references detected</p>
          )}
          {result.output.note ? (
            <p style={{ fontSize: "11px", color: "#8A847B", marginTop: "8px", fontStyle: "italic" }}>{String(result.output.note)}</p>
          ) : null}
          {result.output.contradictions && (result.output.contradictions as unknown[]).length > 0 ? (
            <div className="mt-4">
              <div style={sectionLabelStyle}>Contradictions</div>
              {(result.output.contradictions as Array<Record<string, unknown>>).map((c, i) => (
                <div key={i} className="p-2 rounded mb-2" style={{ border: "1px solid rgba(220, 38, 38, 0.2)", background: "rgba(220, 38, 38, 0.03)", fontSize: "12px" }}>
                  <div style={{ fontWeight: 500, color: "#DC2626", marginBottom: "2px" }}>{String(c.topic)}</div>
                  <div style={{ color: "#3A3328" }}>This doc: {String(c.current_claim || c.current_doc_claim)}</div>
                  <div style={{ color: "#8A847B" }}>{String(c.other_filename || c.other_doc_filename)}: {String(c.other_claim || c.other_doc_claim)}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {!["classify", "extract", "tag", "filter", "webhook", "gate", "resolve_references"].includes(result.stepType) ? (
        <div>
          <div style={sectionLabelStyle}>Output</div>
          <pre style={preStyle}>{JSON.stringify(result.output, null, 2)}</pre>
        </div>
      ) : null}

      {result.edgeEvaluations.length > 0 ? (
        <div className="mt-4 pt-4" style={{ borderTop: "1px solid #E8E0D0" }}>
          <div style={sectionLabelStyle}>Edge Evaluations</div>
          <div className="flex flex-col gap-2">
            {result.edgeEvaluations.map((edge, i) => (
              <div key={i} className="flex items-center gap-2" style={{ fontSize: "12px" }}>
                <span style={{ color: edge.matched ? "#2D8A4E" : "#D4CFC5", fontWeight: 600, fontSize: "14px" }}>
                  {edge.matched ? "✓" : "✗"}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#3A3328" }}>
                  → {edge.to}
                </span>
                {edge.condition ? (
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "10px",
                    color: "#8A847B",
                    background: edge.matched ? "rgba(45, 138, 78, 0.08)" : "rgba(0,0,0,0.03)",
                    padding: "1px 6px",
                    borderRadius: "3px",
                  }}>
                    {edge.condition}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <details className="mt-4 pt-4" style={{ borderTop: "1px solid #E8E0D0" }}>
        <summary style={{ ...sectionLabelStyle, cursor: "pointer", userSelect: "none" as const }}>
          Raw Output
        </summary>
        <pre style={{ ...preStyle, marginTop: "8px" }}>{JSON.stringify(result.output, null, 2)}</pre>
      </details>
    </div>
  );
}

function ClassifyResults({ output }: { output: Record<string, unknown> }) {
  return (
    <div>
      <div style={sectionLabelStyle}>Classification</div>
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <span style={{ fontFamily: "'Fraunces', serif", fontSize: "20px", fontWeight: 500, color: "#171410" }}>
            {String(output.label || "—")}
          </span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
            color: typeof output.confidence === "number" && output.confidence >= 0.8 ? "#2D8A4E" : "#B08D2D",
          }}>
            {typeof output.confidence === "number" ? `${(output.confidence * 100).toFixed(0)}%` : "—"}
          </span>
        </div>
        <div className="flex gap-2">
          <span style={metaLabelStyle}>Method</span>
          <span style={{ fontSize: "12px", color: "#3A3328" }}>{String(output.method || "—")}</span>
        </div>
        {output.reasoning ? (
          <div>
            <div style={metaLabelStyle}>Reasoning</div>
            <p style={{ fontSize: "12px", color: "#3A3328", lineHeight: 1.5, margin: "4px 0 0", fontStyle: "italic" }}>
              {String(output.reasoning)}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ExtractResults({ output }: { output: Record<string, unknown> }) {
  const fields = output.fields as Record<string, unknown> | undefined;
  return (
    <div>
      <div style={sectionLabelStyle}>Extraction</div>
      <div className="flex gap-4 mb-3">
        <div>
          <span style={metaLabelStyle}>Fields</span>
          <div style={metaValueStyle}>{String(output.fieldCount ?? 0)}/{String(output.totalFields ?? 0)}</div>
        </div>
        <div>
          <span style={metaLabelStyle}>Schema</span>
          <div style={metaValueStyle}>{String(output.schema || "—")}</div>
        </div>
      </div>
      {fields && Object.keys(fields).length > 0 ? (
        <div className="flex flex-col gap-1">
          {Object.entries(fields).map(([key, val]) => (
            <div key={key} className="flex justify-between" style={{
              fontSize: "12px", padding: "4px 0", borderBottom: "1px solid rgba(0,0,0,0.04)",
            }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#8A847B" }}>{key}</span>
              <span style={{ color: "#171410", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{String(val)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {output.note ? (
        <p style={{ fontSize: "11px", color: "#8A847B", fontStyle: "italic", marginTop: "8px" }}>{String(output.note)}</p>
      ) : null}
    </div>
  );
}

function TagResults({ output }: { output: Record<string, unknown> }) {
  const tags = output.tags as Record<string, string> | undefined;
  return (
    <div>
      <div style={sectionLabelStyle}>Tags Applied</div>
      {tags && Object.keys(tags).length > 0 ? (
        <div className="flex flex-col gap-1">
          {Object.entries(tags).map(([key, val]) => (
            <div key={key} className="flex gap-2 items-baseline" style={{ fontSize: "12px" }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", fontWeight: 500,
                color: "#C33520", textTransform: "uppercase" as const, letterSpacing: "0.08em",
              }}>{key}</span>
              <span style={{ color: "#3A3328" }}>{val}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: "12px", color: "#8A847B" }}>No tags</p>
      )}
    </div>
  );
}

const metaLabelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "9px",
  fontWeight: 500,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#8A847B",
  marginBottom: "2px",
};

const metaValueStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "13px",
  fontWeight: 500,
  color: "#171410",
};

const sectionLabelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "10px",
  fontWeight: 500,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#8A847B",
  marginBottom: "10px",
};

const preStyle: React.CSSProperties = {
  padding: "12px",
  background: "#171410",
  color: "#F4EEE2",
  borderRadius: "4px",
  fontSize: "11px",
  fontFamily: "'JetBrains Mono', monospace",
  lineHeight: 1.5,
  overflow: "auto",
  maxHeight: "300px",
};
