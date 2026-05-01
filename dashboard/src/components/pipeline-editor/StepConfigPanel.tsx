"use client";

export interface PipelineStep {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

interface StepConfigPanelProps {
  step: PipelineStep;
  onUpdate: (stepId: string, updates: Partial<PipelineStep>) => void;
  onClose: () => void;
  onDelete: (stepId: string) => void;
}

export function StepConfigPanel({ step, onUpdate, onClose, onDelete }: StepConfigPanelProps) {
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
        <ExtractConfig step={step} onUpdate={onUpdate} />
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
  return (
    <>
      <div className="mb-4">
        <label style={labelStyle}>Question</label>
        <textarea
          value={(config.question as string) || ""}
          onChange={(e) =>
            onUpdate(step.id, { config: { ...config, question: e.target.value } })
          }
          style={{ ...inputStyle, minHeight: "80px", resize: "vertical" }}
          placeholder="Is this an insurance-related document?"
        />
      </div>
      <div className="mb-4">
        <label style={labelStyle}>Labels (one per line: id - description)</label>
        <textarea
          value={(
            (config.labels as Array<{ id: string; description?: string }>) || []
          )
            .map(
              (l) =>
                `${l.id}${l.description ? ` - ${l.description}` : ""}`,
            )
            .join("\n")}
          onChange={(e) => {
            const labels = e.target.value
              .split("\n")
              .filter(Boolean)
              .map((line: string) => {
                const [id, ...desc] = line.split(" - ");
                return {
                  id: (id ?? "").trim(),
                  description: desc.join(" - ").trim() || undefined,
                };
              });
            onUpdate(step.id, { config: { ...config, labels } });
          }}
          style={{
            ...inputStyle,
            minHeight: "100px",
            resize: "vertical",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
          }}
          placeholder={"insurance - Any insurance document\nother - Not insurance-related"}
        />
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
          <option value="keyword">Keyword only (free)</option>
          <option value="llm">LLM only</option>
          <option value="keyword_then_llm">Keyword first, LLM fallback</option>
        </select>
      </div>
    </>
  );
}

function ExtractConfig({
  step,
  onUpdate,
}: {
  step: PipelineStep;
  onUpdate: (id: string, u: Partial<PipelineStep>) => void;
}) {
  const config = step.config || {};
  return (
    <div className="mb-4">
      <label style={labelStyle}>Schema</label>
      <input
        type="text"
        value={(config.schema as string) || ""}
        onChange={(e) =>
          onUpdate(step.id, { config: { ...config, schema: e.target.value } })
        }
        style={inputStyle}
        placeholder="commercial_policy"
      />
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
  return (
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
