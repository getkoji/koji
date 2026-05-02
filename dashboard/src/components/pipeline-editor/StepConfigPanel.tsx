"use client";

import { useState, useRef } from "react";

export interface PipelineStep {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

interface SchemaOption {
  slug: string;
  displayName: string;
}

interface StepConfigPanelProps {
  step: PipelineStep;
  onUpdate: (stepId: string, updates: Partial<PipelineStep>) => void;
  onClose: () => void;
  onDelete: (stepId: string) => void;
  schemas?: SchemaOption[];
}

export function StepConfigPanel({ step, onUpdate, onClose, onDelete, schemas = [] }: StepConfigPanelProps) {
  if (!step) return null;

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-[340px] overflow-y-auto z-10"
      style={{
        background: "#F4EEE2",
        borderLeft: "1px solid #E8E0D0",
        padding: "20px",
        fontFamily: "'Instrument Sans', sans-serif",
        boxShadow: "-4px 0 12px rgba(0,0,0,0.05)",
      }}
    >
      <div className="flex justify-between items-center mb-5">
        <h3
          className="text-[16px] font-medium m-0"
          style={{ fontFamily: "'Fraunces', serif" }}
        >
          Configure Step
        </h3>
        <button
          onClick={onClose}
          className="bg-transparent border-none cursor-pointer text-[18px] text-[#8A847B] hover:text-[#171410] transition-colors"
        >
          x
        </button>
      </div>

      {/* Step ID */}
      <div className="mb-4">
        <label style={labelStyle}>Step ID</label>
        <input
          type="text"
          value={step.id}
          onChange={(e) => onUpdate(step.id, { id: e.target.value })}
          style={inputStyle}
        />
      </div>

      {/* Step Type */}
      <div className="mb-4">
        <label style={labelStyle}>Type</label>
        <select
          value={step.type}
          onChange={(e) => onUpdate(step.id, { type: e.target.value })}
          style={inputStyle}
        >
          <option value="classify">Classify</option>
          <option value="extract">Extract</option>
          <option value="ocr">OCR</option>
          <option value="split">Split</option>
          <option value="tag">Tag</option>
          <option value="filter">Filter</option>
          <option value="webhook">Webhook</option>
          <option value="transform">Transform</option>
          <option value="gate">Gate (HITL)</option>
          <option value="redact">Redact</option>
          <option value="enrich">Enrich</option>
          <option value="validate">Validate</option>
          <option value="summarize">Summarize</option>
          <option value="compare">Compare</option>
        </select>
      </div>

      {/* Type-specific config */}
      {step.type === "classify" && (
        <ClassifyConfig step={step} onUpdate={onUpdate} />
      )}
      {step.type === "extract" && (
        <ExtractConfig step={step} onUpdate={onUpdate} schemas={schemas} />
      )}
      {step.type === "tag" && (
        <TagConfig step={step} onUpdate={onUpdate} />
      )}
      {step.type === "filter" && (
        <FilterConfig step={step} onUpdate={onUpdate} />
      )}
      {step.type === "webhook" && (
        <WebhookConfig step={step} onUpdate={onUpdate} />
      )}

      {/* Delete */}
      <div className="mt-8 pt-4 border-t border-[#E8E0D0]">
        <button
          onClick={() => onDelete(step.id)}
          style={{
            ...inputStyle,
            background: "rgba(195, 53, 32, 0.05)",
            color: "#C33520",
            border: "1px solid rgba(195, 53, 32, 0.2)",
            cursor: "pointer",
            textAlign: "center",
            fontWeight: 500,
          }}
        >
          Delete Step
        </button>
      </div>
    </div>
  );
}

// ── Type-specific config panels ──

function ClassifyConfig({
  step,
  onUpdate,
}: {
  step: PipelineStep;
  onUpdate: (id: string, u: Partial<PipelineStep>) => void;
}) {
  const config = step.config || {};
  const labels = (config.labels as Array<{ id: string; description?: string; keywords?: string[] }>) || [];

  function updateLabels(newLabels: typeof labels) {
    onUpdate(step.id, { config: { ...config, labels: newLabels } });
  }

  function addLabel() {
    updateLabels([...labels, { id: "", description: "" }]);
  }

  function removeLabel(index: number) {
    updateLabels(labels.filter((_, i) => i !== index));
  }

  function updateLabel(index: number, updates: Partial<typeof labels[0]>) {
    updateLabels(labels.map((l, i) => i === index ? { ...l, ...updates } : l));
  }

  return (
    <>
      <div className="mb-4">
        <label style={labelStyle}>Question</label>
        <textarea
          value={(config.question as string) || ""}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, question: e.target.value } })
          }
          style={{ ...inputStyle, minHeight: "60px", resize: "vertical" }}
          placeholder="Is this an insurance-related document?"
        />
        <p style={{ fontSize: "10px", color: "#8A847B", marginTop: "4px" }}>
          The question asked to classify the document. Used as the LLM prompt.
        </p>
      </div>

      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <label style={{ ...labelStyle, marginBottom: 0 }}>Labels</label>
          <button
            onClick={addLabel}
            style={{
              padding: "2px 8px",
              fontSize: "11px",
              fontWeight: 500,
              border: "1px solid #E8E0D0",
              borderRadius: "3px",
              background: "transparent",
              color: "#C33520",
              cursor: "pointer",
              fontFamily: "'Instrument Sans', sans-serif",
            }}
          >
            + Add
          </button>
        </div>
        <p style={{ fontSize: "10px", color: "#8A847B", marginBottom: "8px" }}>
          Possible classification results. Each label becomes a routing option on outgoing edges.
        </p>
        <div className="flex flex-col gap-3">
          {labels.map((label, i) => (
            <div key={i} className="p-3 rounded" style={{ border: "1px solid #E8E0D0", background: "#FBF7EB" }}>
              <div className="flex justify-between items-start mb-2">
                <div className="flex-1 mr-2">
                  <div style={{ ...labelStyle, fontSize: "9px" }}>ID</div>
                  <input
                    type="text"
                    value={label.id}
                    onChange={(e) => updateLabel(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                    style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", padding: "4px 8px" }}
                    placeholder="insurance"
                  />
                </div>
                <button
                  onClick={() => removeLabel(i)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#8A847B",
                    fontSize: "14px",
                    padding: "0 4px",
                    marginTop: "14px",
                  }}
                >
                  ×
                </button>
              </div>
              <div className="mb-2">
                <div style={{ ...labelStyle, fontSize: "9px" }}>Description (helps the LLM)</div>
                <input
                  type="text"
                  value={label.description || ""}
                  onChange={(e) => updateLabel(i, { description: e.target.value || undefined })}
                  style={{ ...inputStyle, fontSize: "12px", padding: "4px 8px" }}
                  placeholder="Any insurance document — policy, certificate, claim"
                />
              </div>
              <div>
                <div style={{ ...labelStyle, fontSize: "9px" }}>Keywords (for keyword matching, comma-separated)</div>
                <KeywordsInput
                  keywords={label.keywords || []}
                  onChange={(kw) => updateLabel(i, { keywords: kw })}
                />
              </div>
            </div>
          ))}
          {labels.length === 0 ? (
            <p style={{ fontSize: "12px", color: "#8A847B", fontStyle: "italic", textAlign: "center" as const, padding: "12px" }}>
              No labels yet. Add at least two labels (e.g., "insurance" and "other").
            </p>
          ) : null}
        </div>
      </div>

      <div className="mb-4">
        <label style={labelStyle}>Method</label>
        <select
          value={(config.method as string) || "keyword_then_llm"}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, method: e.target.value } })
          }
          style={inputStyle}
        >
          <option value="keyword">Keyword only (free — no model calls)</option>
          <option value="llm">LLM only (always calls model)</option>
          <option value="keyword_then_llm">Keyword first, LLM fallback (recommended)</option>
        </select>
        <p style={{ fontSize: "10px", color: "#8A847B", marginTop: "4px" }}>
          {(config.method as string) === "keyword"
            ? "Matches keywords only. Free but can't handle ambiguous cases."
            : (config.method as string) === "llm"
            ? "Always calls the model. Most accurate but costs tokens."
            : "Tries keyword matching first (free). Falls back to the model if no keywords match."}
        </p>
      </div>
    </>
  );
}

function KeywordsInput({ keywords, onChange }: { keywords: string[]; onChange: (kw: string[]) => void }) {
  const [text, setText] = useState(keywords.join(", "));
  // Sync from parent when keywords change externally
  const prevRef = useRef(keywords);
  if (prevRef.current !== keywords && keywords.join(", ") !== text) {
    prevRef.current = keywords;
    setText(keywords.join(", "));
  }
  return (
    <input
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const parsed = text.split(",").map(k => k.trim()).filter(Boolean);
        onChange(parsed);
      }}
      style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", padding: "4px 8px" }}
      placeholder="insurance, policy, certificate, claim, ACORD"
    />
  );
}

function ExtractConfig({
  step,
  onUpdate,
  schemas = [],
}: {
  step: PipelineStep;
  onUpdate: (id: string, u: Partial<PipelineStep>) => void;
  schemas?: SchemaOption[];
}) {
  const config = step.config || {};
  const currentSchema = (config.schema as string) || "";

  return (
    <div className="mb-4">
      <label style={labelStyle}>Schema</label>
      {schemas.length > 0 ? (
        <select
          value={currentSchema}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, schema: e.target.value } })
          }
          style={inputStyle}
        >
          <option value="">Select a schema...</option>
          {schemas.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.displayName || s.slug}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={currentSchema}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, schema: e.target.value } })
          }
          style={inputStyle}
          placeholder="commercial_policy"
        />
      )}
    </div>
  );
}

function TagConfig({
  step,
  onUpdate,
}: {
  step: PipelineStep;
  onUpdate: (id: string, u: Partial<PipelineStep>) => void;
}) {
  const config = step.config || {};
  const tags = config.tags || {};
  return (
    <div className="mb-4">
      <label style={labelStyle}>Tags (JSON)</label>
      <textarea
        value={JSON.stringify(tags, null, 2)}
        onChange={(e) => {
          try {
            const parsed = JSON.parse(e.target.value);
            onUpdate(step.id, { config: { ...config, tags: parsed } });
          } catch {
            /* ignore invalid JSON while typing */
          }
        }}
        style={{
          ...inputStyle,
          minHeight: "80px",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "12px",
        }}
        placeholder='{"action": "skip", "reason": "Not in scope"}'
      />
    </div>
  );
}

function FilterConfig({
  step,
  onUpdate,
}: {
  step: PipelineStep;
  onUpdate: (id: string, u: Partial<PipelineStep>) => void;
}) {
  const config = step.config || {};
  return (
    <>
      <div className="mb-4">
        <label style={labelStyle}>Condition</label>
        <input
          type="text"
          value={(config.condition as string) || ""}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, condition: e.target.value } })
          }
          style={{
            ...inputStyle,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
          }}
          placeholder="document.page_count > 1"
        />
      </div>
      <div className="mb-4">
        <label style={labelStyle}>On Fail</label>
        <select
          value={(config.on_fail as string) || "stop"}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, on_fail: e.target.value } })
          }
          style={inputStyle}
        >
          <option value="stop">Stop pipeline</option>
          <option value="tag">Tag and continue</option>
          <option value="fail">Fail document</option>
        </select>
      </div>
    </>
  );
}

function WebhookConfig({
  step,
  onUpdate,
}: {
  step: PipelineStep;
  onUpdate: (id: string, u: Partial<PipelineStep>) => void;
}) {
  const config = step.config || {};
  const headers = (config.headers as Record<string, string>) || {};
  const headerEntries = Object.entries(headers);

  function updateHeaders(newHeaders: Record<string, string>) {
    onUpdate(step.id, { config: { ...config, headers: newHeaders } });
  }

  return (
    <>
      <div className="mb-4">
        <label style={labelStyle}>URL</label>
        <input
          type="text"
          value={(config.url as string) || ""}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, url: e.target.value } })
          }
          style={inputStyle}
          placeholder="https://example.com/api/hooks/intake"
        />
      </div>

      <div className="mb-4">
        <label style={labelStyle}>Method</label>
        <select
          value={(config.method as string) || "POST"}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, method: e.target.value } })
          }
          style={inputStyle}
        >
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
        </select>
      </div>

      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <label style={{ ...labelStyle, marginBottom: 0 }}>Headers</label>
          <button
            onClick={() => updateHeaders({ ...headers, "": "" })}
            style={{
              padding: "2px 8px",
              fontSize: "11px",
              fontWeight: 500,
              border: "1px solid #E8E0D0",
              borderRadius: "3px",
              background: "transparent",
              color: "#C33520",
              cursor: "pointer",
              fontFamily: "'Instrument Sans', sans-serif",
            }}
          >
            + Add
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {headerEntries.map(([key, value], i) => (
            <div key={i} className="flex gap-1 items-start">
              <input
                type="text"
                value={key}
                onChange={(e) => {
                  const entries = Object.entries(headers);
                  entries[i] = [e.target.value, value];
                  updateHeaders(Object.fromEntries(entries));
                }}
                style={{ ...inputStyle, flex: "0 0 40%", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", padding: "4px 6px" }}
                placeholder="Authorization"
              />
              <input
                type="text"
                value={value}
                onChange={(e) => {
                  const newH = { ...headers };
                  newH[key] = e.target.value;
                  updateHeaders(newH);
                }}
                style={{ ...inputStyle, flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", padding: "4px 6px" }}
                placeholder="Bearer token..."
              />
              <button
                onClick={() => {
                  const newH = { ...headers };
                  delete newH[key];
                  updateHeaders(newH);
                }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#8A847B", fontSize: "14px", padding: "4px", flexShrink: 0 }}
              >
                ×
              </button>
            </div>
          ))}
          {headerEntries.length === 0 ? (
            <p style={{ fontSize: "11px", color: "#8A847B", fontStyle: "italic" }}>
              No custom headers. Content-Type: application/json is always included.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mb-4">
        <label style={labelStyle}>Payload</label>
        <select
          value={(config.payload as string) || "result"}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, payload: e.target.value } })
          }
          style={inputStyle}
        >
          <option value="result">Extraction result + document info</option>
          <option value="document">Document metadata only</option>
          <option value="metadata">All step outputs</option>
        </select>
        <p style={{ fontSize: "10px", color: "#8A847B", marginTop: "4px" }}>
          What to include in the POST body sent to the URL.
        </p>
      </div>
    </>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "10px",
  fontWeight: 500,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#8A847B",
  marginBottom: "6px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  fontFamily: "'Instrument Sans', sans-serif",
  border: "1px solid #E8E0D0",
  borderRadius: "4px",
  background: "#FBF7EB",
  color: "#171410",
  outline: "none",
  boxSizing: "border-box",
};
