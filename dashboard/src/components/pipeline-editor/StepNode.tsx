"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type ExecutionState = "idle" | "waiting" | "running" | "completed" | "failed" | "skipped";

function getExecutionSummary(type: string, output: Record<string, unknown>): string {
  switch (type) {
    case "classify":
      return `${output.label || "?"} (${typeof output.confidence === "number" ? output.confidence.toFixed(2) : "?"})`;
    case "extract":
      return `${output.fieldCount || 0}/${output.totalFields || 0} fields · ${typeof output.confidence === "number" ? output.confidence.toFixed(2) : "?"}`;
    case "tag": {
      const tags = output.tags as Record<string, string> | undefined;
      return tags ? Object.keys(tags).join(", ") : "tagged";
    }
    case "filter":
      return output.passed ? "passed" : "blocked";
    case "webhook":
      return output.skipped ? "skipped (test)" : `${output.status_code || "sent"}`;
    case "gate":
      return output.auto_approved ? "auto-approved (test)" : "reviewing";
    case "ocr":
      return `${output.pageCount || "?"} pages`;
    case "split": {
      const sections = output.sections as unknown[];
      return `${sections?.length || "?"} sections`;
    }
    default:
      return "done";
  }
}

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

function getStateBorder(
  executionState: ExecutionState,
  selected: boolean,
  defaultBorder: string,
): { borderColor: string; borderStyle: string } {
  if (selected && executionState === "idle") {
    return { borderColor: "#C33520", borderStyle: "solid" };
  }
  switch (executionState) {
    case "waiting":
      return { borderColor: "#8A847B", borderStyle: "dashed" };
    case "running":
      return { borderColor: "#C33520", borderStyle: "solid" };
    case "completed":
      return { borderColor: "#2D8A4E", borderStyle: "solid" };
    case "failed":
      return { borderColor: "#DC2626", borderStyle: "solid" };
    case "skipped":
      return { borderColor: "#8A847B", borderStyle: "dashed" };
    default:
      return { borderColor: selected ? "#C33520" : defaultBorder, borderStyle: "solid" };
  }
}

function getStateOpacity(executionState: ExecutionState): number {
  switch (executionState) {
    case "waiting":
      return 0.6;
    case "skipped":
      return 0.35;
    default:
      return 1;
  }
}

function getStateOverlay(executionState: ExecutionState): string | null {
  switch (executionState) {
    case "running":
      return "\u23F3"; // hourglass
    case "completed":
      return "\u2705"; // green check
    case "failed":
      return "\u274C"; // red X
    default:
      return null;
  }
}

function StepNodeComponent({ data, selected }: NodeProps) {
  const nodeType = (data.type as string) || "default";
  const colors = stepColors[nodeType] || stepColors.default;
  const icon = stepIcons[nodeType] || "\u2022";
  const executionState = (data.executionState as ExecutionState) || "idle";
  const executionOutput = data.executionOutput as Record<string, unknown> | undefined;
  const executionDuration = data.executionDuration as number | undefined;
  const executionCost = data.executionCost as number | undefined;

  const { borderColor, borderStyle } = getStateBorder(executionState, !!selected, colors.border);
  const opacity = getStateOpacity(executionState);
  const overlay = getStateOverlay(executionState);
  const displayIcon = executionState === "running" ? "\u23F3" : icon;

  return (
    <div
      className={`step-node${executionState === "running" ? " koji-node-running" : ""}`}
      style={{
        background: colors.bg,
        border: `2px ${borderStyle} ${borderColor}`,
        borderRadius: "8px",
        padding: "12px 16px",
        minWidth: "180px",
        fontFamily: "'Instrument Sans', sans-serif",
        boxShadow: selected
          ? "0 0 0 2px rgba(195, 53, 32, 0.2)"
          : "0 1px 3px rgba(0,0,0,0.08)",
        cursor: "pointer",
        transition: "box-shadow 0.2s, border-color 0.2s, opacity 0.3s",
        opacity,
        position: "relative",
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

      {/* State overlay badge */}
      {overlay && executionState !== "running" && (
        <div
          style={{
            position: "absolute",
            top: "-8px",
            right: "-8px",
            fontSize: "14px",
            lineHeight: 1,
            zIndex: 1,
          }}
        >
          {overlay}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "16px" }}>{displayIcon}</span>
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

      {executionState === "running" && executionDuration !== undefined ? (
        <div
          style={{
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "1px solid rgba(195, 53, 32, 0.2)",
            fontSize: "11px",
            color: "#C33520",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {(executionDuration / 1000).toFixed(1)}s...
        </div>
      ) : null}

      {executionState === "completed" && executionOutput ? (
        <div
          style={{
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "1px solid rgba(45, 138, 78, 0.2)",
            fontSize: "11px",
            color: "#2D8A4E",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {getExecutionSummary(nodeType, executionOutput)}
          <span style={{ color: "#8A847B", marginLeft: "8px" }}>
            {executionDuration ? `${(executionDuration / 1000).toFixed(1)}s` : ""}
            {executionCost ? ` \u00B7 $${executionCost.toFixed(3)}` : ""}
          </span>
        </div>
      ) : null}

      {executionState === "failed" && executionOutput?.error ? (
        <div
          style={{
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "1px solid rgba(220, 38, 38, 0.2)",
            fontSize: "11px",
            color: "#DC2626",
            fontFamily: "'JetBrains Mono', monospace",
            maxWidth: "180px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {String(executionOutput.error)}
        </div>
      ) : null}

      {executionState === "skipped" ? (
        <div
          style={{
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "1px solid rgba(0,0,0,0.06)",
            fontSize: "11px",
            color: "#8A847B",
            fontFamily: "'JetBrains Mono', monospace",
            fontStyle: "italic",
          }}
        >
          skipped
        </div>
      ) : null}

      {/* Config summary — only show in idle/waiting states */}
      {(executionState === "idle" || executionState === "waiting") && data.config ? (
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
      ) : null}

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
