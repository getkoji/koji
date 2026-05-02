"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

/**
 * Document input node — the fixed entry point of every pipeline.
 * Shows the document filename + parse result (pages, duration).
 * Not draggable, not deletable, not configurable.
 */
function DocumentInputNodeComponent({ data }: NodeProps) {
  const filename = data.filename as string | undefined;
  const pageCount = data.pageCount as number | undefined;
  const parseDurationMs = data.parseDurationMs as number | undefined;
  const parseStatus = data.parseStatus as string | undefined;

  return (
    <div
      style={{
        background: "#F4EEE2",
        border: "1px solid #D4CFC5",
        borderRadius: "6px",
        padding: "10px 16px",
        minWidth: "160px",
        textAlign: "center" as const,
        fontFamily: "'Instrument Sans', sans-serif",
        opacity: 0.85,
      }}
    >
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "9px",
        fontWeight: 500,
        letterSpacing: "0.14em",
        textTransform: "uppercase" as const,
        color: "#8A847B",
        marginBottom: "4px",
      }}>
        Document Input
      </div>

      {filename ? (
        <div>
          <div style={{
            fontSize: "12px",
            fontWeight: 500,
            color: "#171410",
            maxWidth: "200px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap" as const,
          }}>
            {filename}
          </div>
          {parseStatus === "parsed" && pageCount !== undefined ? (
            <div style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              color: "#8A847B",
              marginTop: "2px",
            }}>
              {pageCount} pages{parseDurationMs ? ` · ${(parseDurationMs / 1000).toFixed(1)}s parse` : ""}
            </div>
          ) : parseStatus === "parsing" ? (
            <div style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              color: "#C33520",
              marginTop: "2px",
            }}>
              parsing...
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{
          fontSize: "11px",
          color: "#B5AFA6",
          fontStyle: "italic",
        }}>
          Drop a document to test
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: "#D4CFC5",
          width: 6,
          height: 6,
          border: "2px solid #F4EEE2",
        }}
      />
    </div>
  );
}

export const DocumentInputNode = memo(DocumentInputNodeComponent);
