"use client";

interface ToolbarProps {
  pipelineName: string;
  costEstimate: number | null;
  onAddStep: () => void;
  onValidate: () => void;
  onDeploy: () => void;
  onToggleYaml: () => void;
  showYaml: boolean;
  stepCount: number;
  dirty: boolean;
  onSave: () => void;
  saving: boolean;
}

export function Toolbar({
  pipelineName,
  costEstimate,
  onAddStep,
  onValidate,
  onDeploy,
  onToggleYaml,
  showYaml,
  stepCount,
  dirty,
  onSave,
  saving,
}: ToolbarProps) {
  return (
    <div
      className="flex items-center justify-between px-5 py-3 border-b border-[#E8E0D0]"
      style={{
        background: "#F4EEE2",
        fontFamily: "'Instrument Sans', sans-serif",
      }}
    >
      <div className="flex items-center gap-4">
        <h2
          className="text-[18px] font-medium m-0 text-[#171410]"
          style={{ fontFamily: "'Fraunces', serif" }}
        >
          {pipelineName}
        </h2>
        <span
          className="text-[11px] text-[#8A847B] bg-[#E8E0D0] px-2 py-0.5 rounded-[3px]"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          {stepCount} step{stepCount !== 1 ? "s" : ""}
        </span>
        {costEstimate !== null && (
          <span
            className="text-[11px] text-[#2D8A4E] bg-[rgba(45,138,78,0.08)] px-2 py-0.5 rounded-[3px]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            ${costEstimate.toFixed(3)}/doc
          </span>
        )}
        {dirty && (
          <span
            className="text-[11px] text-[#B08D2D] bg-[rgba(176,141,45,0.1)] px-2 py-0.5 rounded-[3px]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            unsaved
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={onAddStep} style={buttonStyle}>
          + Add Step
        </button>
        <button
          onClick={onToggleYaml}
          style={{
            ...buttonStyle,
            background: showYaml ? "#3A3328" : "transparent",
            color: showYaml ? "#F4EEE2" : "#3A3328",
          }}
        >
          YAML
        </button>
        <button onClick={onValidate} style={buttonStyle}>
          Validate
        </button>
        {dirty && (
          <button
            onClick={onSave}
            disabled={saving}
            style={{
              ...buttonStyle,
              background: "#3A3328",
              color: "#F4EEE2",
              border: "1px solid #3A3328",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        )}
        <button
          onClick={onDeploy}
          style={{
            ...buttonStyle,
            background: "#C33520",
            color: "#F4EEE2",
            border: "1px solid #C33520",
          }}
        >
          Deploy
        </button>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "13px",
  fontWeight: 500,
  border: "1px solid #E8E0D0",
  borderRadius: "4px",
  background: "transparent",
  color: "#3A3328",
  cursor: "pointer",
  fontFamily: "'Instrument Sans', sans-serif",
  transition: "all 0.2s",
};
