"use client";

import { useState, useEffect } from "react";

interface YamlViewProps {
  yaml: string;
  onChange: (yaml: string) => void;
  onClose: () => void;
}

export function YamlView({ yaml, onChange, onClose }: YamlViewProps) {
  const [value, setValue] = useState(yaml);

  useEffect(() => {
    setValue(yaml);
  }, [yaml]);

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col"
      style={{ background: "#171410" }}
    >
      <div
        className="flex justify-between items-center px-5 py-3"
        style={{
          background: "#1E1B16",
          borderBottom: "1px solid #2A2620",
        }}
      >
        <span
          className="text-[12px] text-[#8A847B] tracking-[0.1em] uppercase"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          Pipeline YAML
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onChange(value)}
            className="px-3 py-1 text-[12px] font-medium rounded-[3px] cursor-pointer border-none"
            style={{
              background: "#C33520",
              color: "#F4EEE2",
              fontFamily: "'Instrument Sans', sans-serif",
            }}
          >
            Apply Changes
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1 text-[12px] font-medium rounded-[3px] cursor-pointer border-none"
            style={{
              background: "transparent",
              color: "#8A847B",
              fontFamily: "'Instrument Sans', sans-serif",
            }}
          >
            Close
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="flex-1 border-none outline-none resize-none"
        style={{
          background: "#171410",
          color: "#F4EEE2",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "13px",
          lineHeight: "1.6",
          padding: "20px",
          tabSize: 2,
        }}
        spellCheck={false}
      />
    </div>
  );
}
