"use client";

import { useState } from "react";
import type { PipelineEdge } from "./PipelineCanvas";

interface EdgeConditionPanelProps {
  edge: PipelineEdge;
  onUpdate: (from: string, to: string, updates: Partial<PipelineEdge>) => void;
  onClose: () => void;
  onDelete: (from: string, to: string) => void;
  /** Labels from classify steps for quick condition building */
  classifyLabels?: Array<{ stepId: string; labels: string[] }>;
}

export function EdgeConditionPanel({ edge, onUpdate, onClose, onDelete, classifyLabels }: EdgeConditionPanelProps) {
  const [conditionMode, setConditionMode] = useState<"visual" | "raw">(
    edge.when ? "raw" : "visual"
  );
  const [field, setField] = useState("output.label");
  const [operator, setOperator] = useState("==");
  const [value, setValue] = useState("");
  const [rawCondition, setRawCondition] = useState(edge.when || "");

  // Parse existing condition into visual fields
  useState(() => {
    if (edge.when) {
      const match = edge.when.match(/^([\w.]+)\s*(==|!=|>=?|<=?|in|not in|contains)\s*'?([^']*)'?$/);
      if (match) {
        setField(match[1]!);
        setOperator(match[2]!);
        setValue(match[3]!);
        setConditionMode("visual");
      } else {
        setConditionMode("raw");
      }
    }
  });

  function applyCondition() {
    let condition: string | undefined;
    if (conditionMode === "visual" && value) {
      if (operator === "in" || operator === "not in") {
        condition = `${field} ${operator} [${value.split(",").map(v => `'${v.trim()}'`).join(", ")}]`;
      } else if (["==", "!=", "contains"].includes(operator)) {
        condition = `${field} ${operator} '${value}'`;
      } else {
        condition = `${field} ${operator} ${value}`;
      }
    } else if (conditionMode === "raw" && rawCondition.trim()) {
      condition = rawCondition.trim();
    }
    onUpdate(edge.from, edge.to, { when: condition, default: false });
    onClose();
  }

  function setAsDefault() {
    onUpdate(edge.from, edge.to, { when: undefined, default: true });
    onClose();
  }

  function removeCondition() {
    onUpdate(edge.from, edge.to, { when: undefined, default: false });
    onClose();
  }

  // Find labels from classify steps for quick select
  const sourceLabels = classifyLabels?.find(c => c.stepId === edge.from)?.labels || [];

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
      <div className="flex justify-between items-center mb-4">
        <h3 style={{
          fontFamily: "'Fraunces', serif",
          fontSize: "16px",
          fontWeight: 500,
          margin: 0,
          color: "#171410",
        }}>
          Edge Condition
        </h3>
        <button
          onClick={onClose}
          className="text-[#8A847B] hover:text-[#171410] bg-transparent border-none cursor-pointer text-[18px]"
        >
          ×
        </button>
      </div>

      {/* Edge info */}
      <div className="mb-4 pb-4" style={{ borderBottom: "1px solid #E8E0D0" }}>
        <div className="flex items-center gap-2" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>
          <span style={{ color: "#3A3328" }}>{edge.from}</span>
          <span style={{ color: "#8A847B" }}>→</span>
          <span style={{ color: "#3A3328" }}>{edge.to}</span>
        </div>
        {edge.default ? (
          <span className="mt-2 inline-block" style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "10px",
            color: "#8A847B",
            background: "rgba(0,0,0,0.04)",
            padding: "2px 6px",
            borderRadius: "3px",
          }}>
            default edge
          </span>
        ) : null}
      </div>

      {/* Quick labels from classify step */}
      {sourceLabels.length > 0 ? (
        <div className="mb-4">
          <div style={labelStyle}>Quick: match classify label</div>
          <div className="flex flex-wrap gap-1">
            {sourceLabels.map(label => (
              <button
                key={label}
                onClick={() => {
                  setConditionMode("visual");
                  setField("output.label");
                  setOperator("==");
                  setValue(label);
                }}
                style={{
                  padding: "3px 10px",
                  fontSize: "11px",
                  fontFamily: "'JetBrains Mono', monospace",
                  border: value === label ? "1px solid #C33520" : "1px solid #E8E0D0",
                  borderRadius: "3px",
                  background: value === label ? "rgba(195, 53, 32, 0.06)" : "transparent",
                  color: value === label ? "#C33520" : "#3A3328",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Mode toggle */}
      <div className="flex gap-1 mb-4">
        <button
          onClick={() => setConditionMode("visual")}
          style={{
            padding: "4px 12px",
            fontSize: "11px",
            fontWeight: 500,
            borderRadius: "3px",
            border: "none",
            cursor: "pointer",
            background: conditionMode === "visual" ? "#171410" : "transparent",
            color: conditionMode === "visual" ? "#F4EEE2" : "#3A3328",
            fontFamily: "'Instrument Sans', sans-serif",
          }}
        >
          Visual
        </button>
        <button
          onClick={() => setConditionMode("raw")}
          style={{
            padding: "4px 12px",
            fontSize: "11px",
            fontWeight: 500,
            borderRadius: "3px",
            border: "none",
            cursor: "pointer",
            background: conditionMode === "raw" ? "#171410" : "transparent",
            color: conditionMode === "raw" ? "#F4EEE2" : "#3A3328",
            fontFamily: "'Instrument Sans', sans-serif",
          }}
        >
          Expression
        </button>
      </div>

      {conditionMode === "visual" ? (
        <div className="flex flex-col gap-3 mb-4">
          <div>
            <div style={labelStyle}>Field</div>
            <select
              value={field}
              onChange={(e) => setField(e.target.value)}
              style={inputStyle}
            >
              <option value="output.label">output.label</option>
              <option value="output.confidence">output.confidence</option>
              <option value="output.passed">output.passed</option>
              <option value="document.page_count">document.page_count</option>
              <option value="document.mime_type">document.mime_type</option>
            </select>
          </div>
          <div>
            <div style={labelStyle}>Operator</div>
            <select
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              style={inputStyle}
            >
              <option value="==">equals (==)</option>
              <option value="!=">not equals (!=)</option>
              <option value=">">greater than (&gt;)</option>
              <option value=">=">greater or equal (&gt;=)</option>
              <option value="<">less than (&lt;)</option>
              <option value="<=">less or equal (&lt;=)</option>
              <option value="in">in list</option>
              <option value="not in">not in list</option>
              <option value="contains">contains</option>
            </select>
          </div>
          <div>
            <div style={labelStyle}>Value</div>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}
              placeholder={operator === "in" ? "value1, value2, value3" : "value"}
            />
          </div>
        </div>
      ) : (
        <div className="mb-4">
          <div style={labelStyle}>Condition expression</div>
          <input
            type="text"
            value={rawCondition}
            onChange={(e) => setRawCondition(e.target.value)}
            style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}
            placeholder="output.label == 'insurance'"
          />
          <p style={{ fontSize: "10px", color: "#8A847B", marginTop: "4px" }}>
            Supports: ==, !=, &gt;, &gt;=, &lt;, &lt;=, in, not in, contains, and, or
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-col gap-2">
        <button
          onClick={applyCondition}
          style={{
            ...inputStyle,
            background: "#C33520",
            color: "#F4EEE2",
            border: "1px solid #C33520",
            cursor: "pointer",
            textAlign: "center" as const,
            fontWeight: 500,
            fontSize: "13px",
          }}
        >
          Apply Condition
        </button>
        <button
          onClick={setAsDefault}
          style={{
            ...inputStyle,
            cursor: "pointer",
            textAlign: "center" as const,
            fontWeight: 500,
            fontSize: "12px",
          }}
        >
          Set as Default Edge
        </button>
        <button
          onClick={removeCondition}
          style={{
            ...inputStyle,
            cursor: "pointer",
            textAlign: "center" as const,
            fontSize: "12px",
            color: "#8A847B",
          }}
        >
          Remove Condition
        </button>
        <div style={{ marginTop: "16px", paddingTop: "16px", borderTop: "1px solid #E8E0D0" }}>
          <button
            onClick={() => { onDelete(edge.from, edge.to); onClose(); }}
            style={{
              ...inputStyle,
              background: "rgba(195, 53, 32, 0.05)",
              color: "#C33520",
              border: "1px solid rgba(195, 53, 32, 0.2)",
              cursor: "pointer",
              textAlign: "center" as const,
              fontWeight: 500,
            }}
          >
            Delete Edge
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
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
  boxSizing: "border-box" as const,
};
