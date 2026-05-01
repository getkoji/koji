"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

// Step type to icon mapping
const stepIcons: Record<string, string> = {
  classify: "\u{1F3F7}",
  extract: "\u{1F4C4}",
  ocr: "\u{1F50D}",
  split: "\u2702\uFE0F",
  tag: "\u{1F516}",
  filter: "\u26A1",
  webhook: "\u{1F517}",
  transform: "\u2699\uFE0F",
  gate: "\u270B",
  redact: "\u{1F512}",
  enrich: "\u{1F4E5}",
  validate: "\u2713",
  summarize: "\u{1F4DD}",
  compare: "\u21C4",
  merge_documents: "\u{1F4CE}",
};

// Step type to color mapping
const stepColors: Record<string, { bg: string; border: string; text: string }> = {
  classify: { bg: "#FFF8F0", border: "#C33520", text: "#C33520" },
  extract: { bg: "#F0F4F0", border: "#2D8A4E", text: "#2D8A4E" },
  tag: { bg: "#F5F3EE", border: "#8A847B", text: "#3A3328" },
  filter: { bg: "#FFF8F0", border: "#B08D2D", text: "#B08D2D" },
  webhook: { bg: "#F0F0F8", border: "#4A5568", text: "#4A5568" },
  default: { bg: "#F4EEE2", border: "#3A3328", text: "#3A3328" },
};

function getConfigSummary(type: string, config: Record<string, unknown>): string {
  switch (type) {
    case "classify": {
      const q = config.question as string | undefined;
      return q ? q.slice(0, 40) + (q.length > 40 ? "..." : "") : "Configure question...";
    }
    case "extract":
      return `schema: ${config.schema || "not set"}`;
    case "tag": {
      const tags = config.tags as Record<string, string> | undefined;
      return tags ? Object.keys(tags).join(", ") : "no tags";
    }
    case "filter":
      return (config.condition as string) || "no condition";
    case "webhook": {
      const url = config.url as string | undefined;
      return url ? url.replace(/^https?:\/\//, "").slice(0, 30) : "no URL";
    }
    default:
      return "";
  }
}

function StepNodeComponent({ data, selected }: NodeProps) {
  const nodeType = (data.type as string) || "default";
  const colors = stepColors[nodeType] || stepColors.default;
  const icon = stepIcons[nodeType] || "\u2022";

  return (
    <div
      className="step-node"
      style={{
        background: colors.bg,
        border: `2px solid ${selected ? "#C33520" : colors.border}`,
        borderRadius: "8px",
        padding: "12px 16px",
        minWidth: "180px",
        fontFamily: "'Instrument Sans', sans-serif",
        boxShadow: selected
          ? "0 0 0 2px rgba(195, 53, 32, 0.2)"
          : "0 1px 3px rgba(0,0,0,0.08)",
        cursor: "pointer",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: colors.border,
          width: 8,
          height: 8,
          border: "2px solid #F4EEE2",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "16px" }}>{icon}</span>
        <div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              fontWeight: 500,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: colors.text,
              opacity: 0.7,
            }}
          >
            {nodeType}
          </div>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 500,
              color: "#171410",
              marginTop: "2px",
              maxWidth: "160px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {(data.label as string) || (data.stepId as string) || "Untitled"}
          </div>
        </div>
      </div>

      {/* Show config summary */}
      {data.config && (
        <div
          style={{
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "1px solid rgba(0,0,0,0.06)",
            fontSize: "11px",
            color: "#8A847B",
            fontFamily: "'JetBrains Mono', monospace",
            maxWidth: "180px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {getConfigSummary(nodeType, data.config as Record<string, unknown>)}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: colors.border,
          width: 8,
          height: 8,
          border: "2px solid #F4EEE2",
        }}
      />
    </div>
  );
}

export const StepNode = memo(StepNodeComponent);
