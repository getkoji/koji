"use client";

import { useState } from "react";

const stepTypes = [
  { type: "classify", label: "Classify", description: "Classify document type using keywords or LLM", icon: "\u{1F3F7}", available: true },
  { type: "extract", label: "Extract", description: "Run extraction pipeline against a schema", icon: "\u{1F4C4}", available: true },
  { type: "tag", label: "Tag", description: "Apply metadata tags to the document", icon: "\u{1F516}", available: true },
  { type: "filter", label: "Filter", description: "Conditional guard \u2014 stop or continue", icon: "\u26A1", available: true },
  { type: "webhook", label: "Webhook", description: "Send results to an external URL", icon: "\u{1F517}", available: true },
  { type: "transform", label: "Transform", description: "Rename or compute fields", icon: "\u2699\uFE0F", available: true },
  { type: "split", label: "Split", description: "Split multi-document packet into sections", icon: "\u2702\uFE0F", available: false },
  { type: "gate", label: "Gate (HITL)", description: "Pause for human review", icon: "\u270B", available: false },
  { type: "ocr", label: "OCR", description: "Extract text from scanned documents", icon: "\u{1F50D}", available: false },
  { type: "redact", label: "Redact", description: "Mask or remove PII", icon: "\u{1F512}", available: false },
  { type: "enrich", label: "Enrich", description: "Look up external data", icon: "\u{1F4E5}", available: false },
  { type: "validate", label: "Validate", description: "Run custom business rules", icon: "\u2713", available: false },
  { type: "summarize", label: "Summarize", description: "Generate document summary", icon: "\u{1F4DD}", available: false },
];

interface AddStepModalProps {
  onAdd: (type: string, id: string) => void;
  onClose: () => void;
}

export function AddStepModal({ onAdd, onClose }: AddStepModalProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [stepId, setStepId] = useState("");

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "rgba(23, 20, 16, 0.5)" }}
      onClick={onClose}
    >
      <div
        className="rounded-lg p-6 w-[480px] max-h-[80vh] overflow-y-auto"
        style={{
          background: "#F4EEE2",
          boxShadow: "0 24px 80px rgba(23, 20, 16, 0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          className="text-[20px] font-medium m-0 mb-4 text-[#171410]"
          style={{ fontFamily: "'Fraunces', serif" }}
        >
          Add Step
        </h3>

        {!selectedType ? (
          <div className="grid gap-2">
            {stepTypes.map((st) => (
              <button
                key={st.type}
                onClick={() => {
                  if (!st.available) return;
                  setSelectedType(st.type);
                  setStepId(
                    st.type + "_" + Math.random().toString(36).slice(2, 6),
                  );
                }}
                className="flex items-center gap-3 p-3 bg-transparent border border-[#E8E0D0] rounded-md text-left transition-colors"
                style={{
                  cursor: st.available ? "pointer" : "default",
                  opacity: st.available ? 1 : 0.55,
                }}
                onMouseEnter={(e) => {
                  if (st.available) {
                    (e.currentTarget as HTMLElement).style.borderColor = "#C33520";
                    (e.currentTarget as HTMLElement).style.background = "rgba(195, 53, 32, 0.03)";
                  }
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = "#E8E0D0";
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <span className="text-[20px] shrink-0">{st.icon}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[14px] text-[#171410]">
                      {st.label}
                    </span>
                    {!st.available ? (
                      <span
                        className="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          background: "rgba(138, 132, 123, 0.1)",
                          color: "#8A847B",
                        }}
                      >
                        Coming Soon
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[12px] text-[#8A847B]">
                    {st.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <div className="mb-4">
              <label
                className="block text-[10px] font-medium tracking-[0.12em] uppercase text-[#8A847B] mb-1.5"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Step ID
              </label>
              <input
                type="text"
                value={stepId}
                onChange={(e) => setStepId(e.target.value)}
                className="w-full px-2.5 py-2 text-[13px] border border-[#E8E0D0] rounded bg-[#FBF7EB] text-[#171410] outline-none"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSelectedType(null)}
                className="px-4 py-2 text-[13px] border border-[#E8E0D0] rounded bg-transparent cursor-pointer hover:border-[#3A3328] transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (stepId.trim()) {
                    onAdd(selectedType, stepId.trim());
                    onClose();
                  }
                }}
                className="px-4 py-2 text-[13px] font-medium border border-[#C33520] rounded cursor-pointer transition-colors"
                style={{
                  background: "#C33520",
                  color: "#F4EEE2",
                }}
              >
                Add Step
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
