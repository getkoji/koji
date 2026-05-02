"use client";

import { useCallback, useRef, useState } from "react";

interface TestModeControlsProps {
  pipelineSlug: string;
  onTestStart: () => void;
  onStepEvent: (event: { type: string; data: Record<string, unknown> }) => void;
  onTestComplete: (result: Record<string, unknown>) => void;
  onTestError: (error: string) => void;
  onReset: () => void;
  isRunning: boolean;
  completedStepCount: number;
  totalStepCount: number;
  totalDurationMs: number;
  totalCostUsd: number;
  path: string[];
}

export function TestModeControls({
  pipelineSlug,
  onTestStart,
  onStepEvent,
  onTestComplete,
  onTestError,
  onReset,
  isRunning,
  completedStepCount,
  totalStepCount,
  totalDurationMs,
  totalCostUsd,
  path,
}: TestModeControlsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runTest = useCallback(async (file: File) => {
    setFileName(file.name);
    onTestStart();

    const formData = new FormData();
    formData.append("file", file);

    abortRef.current = new AbortController();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";

    try {
      const response = await fetch(
        `${apiUrl}/api/pipelines/${pipelineSlug}/test?stream=true`,
        {
          method: "POST",
          body: formData,
          credentials: "include",
          signal: abortRef.current.signal,
        }
      );

      if (!response.ok) {
        const text = await response.text();
        onTestError(`Test failed: ${text}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onTestError("No response body");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              onStepEvent({ type: eventType, data });
              if (eventType === "pipeline_complete" || eventType === "pipeline_paused") {
                onTestComplete(data);
              }
            } catch {
              // skip malformed JSON
            }
            eventType = "";
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onTestError(err instanceof Error ? err.message : "Test failed");
      }
    }
  }, [pipelineSlug, onTestStart, onStepEvent, onTestComplete, onTestError]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) runTest(file);
  }, [runTest]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) runTest(file);
  }, [runTest]);

  const hasResults = completedStepCount > 0;

  return (
    <div>
      {!isRunning && !hasResults ? (
        <div
          className="mx-5 mt-3 mb-2 rounded-lg cursor-pointer transition-all"
          style={{
            border: `2px dashed ${dragOver ? "#C33520" : "#D4CFC5"}`,
            background: dragOver ? "rgba(195, 53, 32, 0.03)" : "rgba(0,0,0,0.02)",
            padding: "20px",
            textAlign: "center" as const,
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.tiff,.doc,.docx,.txt,.csv,.json"
            onChange={handleFileSelect}
          />
          <div style={{
            fontFamily: "'Instrument Sans', sans-serif",
            fontSize: "14px",
            fontWeight: 500,
            color: "#3A3328",
            marginBottom: "4px",
          }}>
            Drop a document to test
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "11px",
            color: "#8A847B",
          }}>
            PDF, images, Word, text, JSON
          </div>
        </div>
      ) : null}

      {isRunning || hasResults ? (
        <div
          className="mx-5 mt-2 mb-2 px-4 py-2 rounded flex items-center justify-between"
          style={{
            background: isRunning ? "rgba(195, 53, 32, 0.04)" : "rgba(45, 138, 78, 0.04)",
            border: `1px solid ${isRunning ? "rgba(195, 53, 32, 0.15)" : "rgba(45, 138, 78, 0.15)"}`,
          }}
        >
          <div className="flex items-center gap-3">
            <span style={{
              display: "inline-block",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: isRunning ? "#C33520" : "#2D8A4E",
              animation: isRunning ? "koji-pulse-dot 1.5s ease-in-out infinite" : "none",
            }} />
            <div>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: "#3A3328",
                maxWidth: "200px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap" as const,
                display: "inline-block",
                verticalAlign: "middle",
              }}>
                {fileName}
              </span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: "#8A847B",
                marginLeft: "8px",
              }}>
                {isRunning ? `${completedStepCount} steps...` : `${completedStepCount}/${totalStepCount} steps`}
              </span>
            </div>
            {totalDurationMs > 0 ? (
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: "#8A847B",
              }}>
                {(totalDurationMs / 1000).toFixed(1)}s · ${totalCostUsd.toFixed(3)}
              </span>
            ) : null}
            {!isRunning && path.length > 0 ? (
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "10px",
                color: "#B5AFA6",
                maxWidth: "300px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap" as const,
              }}>
                {path.join(" → ")}
              </span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button onClick={onReset} style={controlButtonStyle}>
              {isRunning ? "Cancel" : "Reset"}
            </button>
            {!isRunning ? (
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{ ...controlButtonStyle, background: "#C33520", color: "#F4EEE2", border: "1px solid #C33520" }}
              >
                Test Another
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes koji-pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

const controlButtonStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: "11px",
  fontWeight: 500,
  border: "1px solid #E8E0D0",
  borderRadius: "3px",
  background: "transparent",
  color: "#3A3328",
  cursor: "pointer",
  fontFamily: "'Instrument Sans', sans-serif",
};
