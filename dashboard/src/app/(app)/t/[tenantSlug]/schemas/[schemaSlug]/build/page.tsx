"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { WorkbenchLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { Switch, Label } from "@koji/ui";
import { schemas as schemasApi } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { MOCK_SCHEMA_LINES, MOCK_EXTRACTION } from "@/lib/mock-schema";

export default function BuildModePage() {
  const [autoRun, setAutoRun] = useState(true);
  const params = useParams<{ schemaSlug: string }>();
  const schemaSlug = params.schemaSlug ?? "invoice";

  const { data: schemaData, live } = useApi(
    () => schemasApi.get(schemaSlug),
    { slug: schemaSlug, displayName: schemaSlug, description: null, createdAt: "", draftYaml: null },
  );

  const header = (
    <>
      <Breadcrumbs
        items={[
          { label: "acme-invoices", href: "#" },
          { label: "Schemas", href: "#" },
          { label: "invoice" },
        ]}
      />
      <PageHeader
        title="invoice"
        badge={
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] font-medium text-ink-3 px-2 py-0.5 border border-border-strong rounded-sm">
              v12
            </span>
            <span className="font-mono text-[10px] font-medium text-vermillion-2 px-2 py-0.5 bg-vermillion-3 rounded-sm uppercase tracking-[0.05em]">
              2 unsaved
            </span>
          </div>
        }
        meta={
          <span className="text-ink-3 text-[13.5px]" style={{ fontFamily: "var(--font-body)" }}>
            Commercial invoice extraction. 8 fields covering number, dates, parties, line items, and totals.
          </span>
        }
        actions={
          <>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
              History
            </button>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
              Discard
            </button>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors">
              Save v13
            </button>
          </>
        }
      />
    </>
  );

  const toolbar = (
    <>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4">
          Mode
        </span>
        <div className="inline-flex p-[3px] bg-cream-2 border border-border rounded-sm">
          <button className="inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-sm text-[12px] font-medium bg-cream text-ink shadow-[0_1px_0_rgba(23,20,16,0.04)]">
            <span className="font-mono text-[13px] text-vermillion-2">✦</span>
            Build
          </button>
          <button className="inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-sm text-[12px] font-medium text-ink-3 hover:text-ink transition-colors">
            <span className="font-mono text-[13px] text-ink-4">▦</span>
            Validate
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className="inline-flex items-center gap-1.5 px-3 py-[7px] bg-cream-2 border border-border rounded-sm font-mono text-[11px] text-ink-2">
          <span className="text-ink-4 uppercase tracking-[0.1em] text-[9.5px]">Sample</span>
          <span className="text-ink">invoice-0042.pdf</span>
          <span className="text-ink-4 text-[10px]">▾</span>
        </button>
        <button className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-vermillion-2 text-cream rounded-sm text-[12px] font-medium hover:bg-ink transition-colors">
          <span className="text-[11px]">▶</span>
          Run
          <kbd className="font-mono text-[9.5px] px-1 py-px border border-cream/25 rounded-sm text-cream-3 ml-1">
            ⌘↵
          </kbd>
        </button>
        <div className="flex items-center gap-1.5">
          <Switch
            id="auto-run"
            size="sm"
            checked={autoRun}
            onCheckedChange={setAutoRun}
          />
          <Label htmlFor="auto-run" className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.08em] cursor-pointer">
            Auto
          </Label>
        </div>
      </div>
    </>
  );

  return (
    <WorkbenchLayout
      header={header}
      toolbar={toolbar}
      columns="0.6fr 1fr"
      panes={[
        /* Left: Schema YAML editor */
        <div key="schema" className="flex flex-col h-full">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
            <span className="font-mono text-[9.5px] font-medium tracking-[0.14em] uppercase text-ink-4">
              Schema
            </span>
            <div className="flex items-center gap-0.5">
              <span className="font-mono text-[11px] text-ink-2">invoice.yaml</span>
              <span className="text-cream-4 text-[9px] mx-1">●</span>
              <span className="font-mono text-[11px] text-vermillion-2 font-medium">modified</span>
              <div className="flex gap-0.5 ml-3">
                <button className="font-mono text-[10px] text-ink-3 px-2 py-0.5 rounded-sm hover:bg-cream-2 hover:text-ink transition-colors">
                  fmt
                </button>
                <button className="font-mono text-[10px] text-ink-3 px-2 py-0.5 rounded-sm hover:bg-cream-2 hover:text-ink transition-colors">
                  lint
                </button>
              </div>
            </div>
          </div>
          <div className="flex-1 py-3.5 font-mono text-[12px] leading-[1.75] overflow-y-auto">
            {MOCK_SCHEMA_LINES.map((line) => (
              <div
                key={line.num}
                className={`flex px-4 whitespace-pre ${line.added ? "bg-green/[0.08]" : ""}`}
              >
                <span className="text-cream-4 min-w-[1.9rem] text-right pr-3 select-none">
                  {line.num}
                </span>
                <span className={`w-2.5 shrink-0 text-center font-medium ${line.added ? "text-green" : ""}`}>
                  {line.added ? "+" : ""}
                </span>
                <span
                  className="flex-1"
                  dangerouslySetInnerHTML={{ __html: line.content || "&nbsp;" }}
                />
              </div>
            ))}
          </div>
          <div className="px-3.5 py-2 border-t border-border font-mono text-[10px] text-ink-4 flex items-center justify-between">
            <span>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green mr-1.5 align-[1px]" />
              YAML valid · 8 fields declared
            </span>
            <span>Ln 24, Col 12</span>
          </div>
        </div>,

        /* Right: Document preview with extraction results */
        <div key="doc" className="flex flex-col h-full">
          {/* Confidence strip */}
          <div className="flex items-center gap-4 px-4 py-3 border-b border-border">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">
                Confidence
              </span>
              <span
                className="font-display text-xl font-medium text-green leading-none"
                style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}
              >
                0.97
              </span>
            </div>
            <div className="w-px h-7 bg-border" />
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">
                Duration
              </span>
              <span
                className="font-display text-xl font-medium text-ink leading-none"
                style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}
              >
                2.3<span className="font-body text-[11px] font-normal text-ink-3 ml-0.5">s</span>
              </span>
            </div>
            <div className="w-px h-7 bg-border" />
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">
                Fields
              </span>
              <span
                className="font-display text-xl font-medium text-green leading-none"
                style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}
              >
                8<span className="font-body text-[11px] font-normal text-ink-3 ml-0.5">/ 8</span>
              </span>
            </div>
            <div className="ml-auto font-mono text-[10px] text-ink-4 uppercase tracking-[0.08em] flex items-center gap-2">
              <span className="w-[7px] h-[7px] rounded-full bg-vermillion-2 animate-pulse" />
              Last run 3s ago
            </div>
          </div>

          {/* Document + field results side by side */}
          <div className="flex-1 grid grid-cols-[1fr_0.9fr] gap-px bg-border overflow-hidden">
            {/* Document preview */}
            <div className="bg-gradient-to-b from-cream-2 to-cream-3 flex justify-center p-6 overflow-auto">
              <div
                className="relative w-full max-w-[460px] bg-[#FFFCF4] shadow-[0_1px_0_rgba(23,20,16,0.05),0_8px_24px_rgba(23,20,16,0.12),0_2px_6px_rgba(23,20,16,0.08)] p-7 font-serif text-[10px] text-[#2A2420] leading-[1.4]"
                style={{ aspectRatio: "8.5 / 11" }}
              >
                <div className="flex justify-between pb-3 border-b border-[#D4CDB8] mb-4">
                  <div>
                    <div className="text-lg font-medium text-[#1A1612] tracking-tight">Brighton &amp; Co.</div>
                    <div className="text-[8px] text-[#736755] mt-0.5 uppercase tracking-[0.05em]">Contractors</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[26px] font-normal text-[#1A1612] tracking-[0.04em] leading-none">INVOICE</div>
                    <div className="text-[8.5px] text-[#736755] mt-1">No. 2026-087 · Mar 28, 2026</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-5 mb-4 text-[9.5px]">
                  <div>
                    <div className="text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] mb-0.5">From</div>
                    <div><strong>Brighton &amp; Co. Contractors</strong><br />441 Market Street<br />San Francisco, CA 94105</div>
                  </div>
                  <div>
                    <div className="text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] mb-0.5">Bill to</div>
                    <div><strong>Vantage Capital</strong><br />220 Battery Street, Suite 300<br />San Francisco, CA 94111</div>
                  </div>
                </div>
                <table className="w-full border-collapse text-[9px] mb-3">
                  <thead>
                    <tr>
                      <th className="text-left text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] py-1.5 border-b border-[#B0A688]">Description</th>
                      <th className="text-right text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] py-1.5 border-b border-[#B0A688]">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td className="py-1 border-b border-dotted border-[#D4CDB8]">Foundation inspection</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8] tabular-nums">$3,750.00</td></tr>
                    <tr><td className="py-1 border-b border-dotted border-[#D4CDB8]">Materials + labor</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8] tabular-nums">$500.00</td></tr>
                  </tbody>
                </table>
                <div className="ml-auto w-[45%] text-[9.5px]">
                  <div className="flex justify-between py-0.5">
                    <span>Subtotal</span><span className="tabular-nums">$3,950.00</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span>Tax</span><span className="tabular-nums">$300.00</span>
                  </div>
                  <div className="flex justify-between pt-1.5 mt-0.5 border-t-2 border-[#1A1612] font-semibold text-[12px]">
                    <span>TOTAL</span><span className="tabular-nums">$4,250.00</span>
                  </div>
                </div>

                {/* Extraction overlays */}
                <div className="absolute top-[42px] right-8 w-[118px] h-[13px] border-[1.5px] border-vermillion-2 bg-vermillion-2/[0.06] rounded-sm" />
                <div className="absolute top-[58px] right-8 w-[92px] h-[12px] border-[1.5px] border-vermillion-2 bg-vermillion-2/[0.06] rounded-sm" />
                <div className="absolute top-[102px] left-8 w-[128px] h-[13px] border-[1.5px] border-vermillion-2 bg-vermillion-2/[0.06] rounded-sm" />
                <div className="absolute top-[102px] left-[50%] ml-[-20px] w-[108px] h-[13px] border-[1.5px] border-vermillion-2 bg-vermillion-2/[0.06] rounded-sm" />
                <div className="absolute bottom-[132px] right-8 w-[175px] h-[24px] border-2 border-vermillion-2 bg-vermillion-2/[0.14] rounded-sm shadow-[0_0_0_3px_rgba(153,39,24,0.08)]" />
              </div>
            </div>

            {/* Field results */}
            <div className="flex flex-col bg-cream overflow-auto">
              <div className="flex items-baseline justify-between px-4 py-3 border-b border-border">
                <span className="font-mono text-[9px] font-medium tracking-[0.14em] uppercase text-ink-4">
                  Extracted fields
                </span>
                <span className="font-mono text-[10px] text-ink-3">8 / 8</span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {MOCK_EXTRACTION.map((f) => (
                  <div
                    key={f.name}
                    className="grid items-baseline gap-2.5 px-4 py-2 border-b border-dotted border-border text-[11.5px]"
                    style={{ gridTemplateColumns: "auto 1fr auto" }}
                  >
                    <span className="font-mono text-[11px] text-ink font-medium">{f.name}</span>
                    <span className="font-mono text-[11px] text-ink-2 truncate min-w-0">{f.value}</span>
                    <span className="font-mono text-[9.5px] text-green">{f.confidence.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>,
      ]}
    />
  );
}
