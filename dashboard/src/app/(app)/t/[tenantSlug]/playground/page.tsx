"use client";

import { WorkbenchLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { MOCK_SCHEMA_LINES, MOCK_EXTRACTION } from "@/lib/mock-schema";

export default function PlaygroundPage() {
  const header = (
    <>
      <Breadcrumbs
        items={[
          { label: "acme-invoices", href: "#" },
          { label: "Playground" },
        ]}
      />
      <PageHeader
        title="Try a document."
        badge={
          <span
            className="font-display text-[30px] font-medium text-vermillion-2 italic leading-none tracking-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}
          >
            See exactly what it found.
          </span>
        }
        meta={
          <span className="text-ink-3 text-[13.5px]" style={{ fontFamily: "var(--font-body)" }}>
            Upload any document, pick or sketch a schema, and watch Koji extract structured data with per-field confidence and provenance.
          </span>
        }
        actions={
          <>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
              New document
            </button>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
              Export JSON
            </button>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
              Save to project
            </button>
          </>
        }
      />
    </>
  );

  return (
    <WorkbenchLayout
      header={header}
      columns="0.95fr 1.25fr 1fr"
      panes={[
        /* Left: Schema */
        <div key="schema" className="flex flex-col h-full">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
            <span className="font-mono text-[9.5px] font-medium tracking-[0.14em] uppercase text-ink-4">Schema</span>
            <div className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-ink-2">schemas/invoice.yaml</span>
              <span className="text-cream-4 text-[9px] mx-1">●</span>
              <span className="font-mono text-[11px] text-ink-3">v12</span>
              <div className="flex gap-0.5 ml-3">
                <button className="font-mono text-[10px] text-ink-3 px-2 py-0.5 rounded-sm hover:bg-cream-2 hover:text-ink transition-colors">edit</button>
                <button className="font-mono text-[10px] text-ink-3 px-2 py-0.5 rounded-sm hover:bg-cream-2 hover:text-ink transition-colors">new</button>
              </div>
            </div>
          </div>
          <div className="flex-1 py-3 font-mono text-[11.5px] leading-[1.7] overflow-y-auto">
            {MOCK_SCHEMA_LINES.filter(l => !l.added).map((line) => (
              <div key={line.num} className="flex px-4 whitespace-pre">
                <span className="text-cream-4 min-w-[1.9rem] text-right pr-3 select-none">{line.num}</span>
                <span className="flex-1" dangerouslySetInnerHTML={{ __html: line.content || "&nbsp;" }} />
              </div>
            ))}
          </div>
          <div className="px-3.5 py-2 border-t border-border font-mono text-[10px] text-ink-4 flex items-center justify-between">
            <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-green mr-1.5 align-[1px]" />valid · 8 fields</span>
            <span>yaml · linted</span>
          </div>
        </div>,

        /* Center: Document */
        <div key="doc" className="flex flex-col h-full">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
            <span className="font-mono text-[9.5px] font-medium tracking-[0.14em] uppercase text-ink-4">Document</span>
            <div className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-ink-2">invoice-0042.pdf</span>
              <span className="text-cream-4 text-[9px] mx-1">●</span>
              <span className="font-mono text-[11px] text-ink-3">1 page</span>
            </div>
            <div className="flex gap-0.5">
              <button className="font-mono text-[10px] text-ink-3 px-2 py-0.5 rounded-sm hover:bg-cream-2 hover:text-ink transition-colors">−</button>
              <button className="font-mono text-[10px] text-ink-3 px-2 py-0.5 rounded-sm hover:bg-cream-2 hover:text-ink transition-colors">+</button>
              <button className="font-mono text-[10px] text-ink-3 px-2 py-0.5 rounded-sm hover:bg-cream-2 hover:text-ink transition-colors">fit</button>
            </div>
          </div>
          <div className="flex-1 bg-gradient-to-b from-cream-2 to-cream-3 flex justify-center p-6 overflow-auto">
            <div
              className="relative w-full max-w-[460px] bg-[#FFFCF4] shadow-[0_1px_0_rgba(23,20,16,0.05),0_8px_24px_rgba(23,20,16,0.12),0_2px_6px_rgba(23,20,16,0.08)] p-7 font-serif text-[10px] text-[#2A2420] leading-[1.4]"
              style={{ aspectRatio: "8.5 / 11" }}
            >
              <div className="flex justify-between pb-3 border-b border-[#D4CDB8] mb-4">
                <div>
                  <div className="text-lg font-medium text-[#1A1612] tracking-tight">Acme Consulting</div>
                  <div className="text-[8px] text-[#736755] mt-0.5 uppercase tracking-[0.05em]">LLC · Since 2019</div>
                </div>
                <div className="text-right">
                  <div className="text-[26px] font-normal text-[#1A1612] tracking-[0.04em] leading-none">INVOICE</div>
                  <div className="text-[8.5px] text-[#736755] mt-1">No. INV-2026-0042<br />Issued: March 15, 2026</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-5 mb-4 text-[9.5px]">
                <div>
                  <div className="text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] mb-0.5">From</div>
                  <div><strong>Acme Consulting LLC</strong><br />2200 Mission Street, Ste 400<br />San Francisco, CA 94110</div>
                </div>
                <div>
                  <div className="text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] mb-0.5">Bill to</div>
                  <div><strong>Prudential Financial</strong><br />751 Broad Street<br />Newark, NJ 07102</div>
                </div>
              </div>
              <table className="w-full border-collapse text-[9px] mb-3">
                <thead>
                  <tr>
                    <th className="text-left text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] py-1.5 border-b border-[#B0A688]">Description</th>
                    <th className="text-right text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] py-1.5 border-b border-[#B0A688]">Qty</th>
                    <th className="text-right text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] py-1.5 border-b border-[#B0A688]">Rate</th>
                    <th className="text-right text-[7.5px] font-semibold uppercase tracking-[0.08em] text-[#736755] py-1.5 border-b border-[#B0A688]">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="py-1 border-b border-dotted border-[#D4CDB8]">Strategic consulting — Q1 2026</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8]">8</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8]">$425.00</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8] tabular-nums">$3,400.00</td></tr>
                  <tr><td className="py-1 border-b border-dotted border-[#D4CDB8]">Documentation review + edits</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8]">2</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8]">$275.00</td><td className="text-right py-1 border-b border-dotted border-[#D4CDB8] tabular-nums">$550.00</td></tr>
                </tbody>
              </table>
              <div className="ml-auto w-[45%] text-[9.5px]">
                <div className="flex justify-between py-0.5 border-t border-[#B0A688] pt-1"><span>Subtotal</span><span className="tabular-nums">$3,950.00</span></div>
                <div className="flex justify-between py-0.5"><span>Tax (7.625%)</span><span className="tabular-nums">$300.00</span></div>
                <div className="flex justify-between pt-1.5 mt-0.5 border-t-2 border-[#1A1612] font-semibold text-[12px]"><span>TOTAL</span><span className="tabular-nums">$4,250.00</span></div>
              </div>
              {/* Extraction highlight on total */}
              <div className="absolute bottom-[90px] right-7 w-[140px] h-[20px] border-2 border-vermillion-2 bg-vermillion-2/[0.14] rounded-sm shadow-[0_0_0_3px_rgba(153,39,24,0.08)]" />
              <div className="absolute bottom-[72px] right-7 font-mono text-[8px] font-medium text-cream bg-vermillion-2 px-1.5 py-px rounded-sm">total_amount · 0.99</div>
              <div className="absolute bottom-7 left-7 right-7 pt-2 border-t border-[#D4CDB8] text-[7.5px] text-[#736755] text-center tracking-[0.05em]">
                Net 30 · Payable to Acme Consulting LLC · Wire details on request
              </div>
            </div>
          </div>
        </div>,

        /* Right: Extracted results */
        <div key="result" className="flex flex-col h-full">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
            <span className="font-mono text-[9.5px] font-medium tracking-[0.14em] uppercase text-ink-4">Extracted</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-green">0.97 confidence</span>
              <span className="text-cream-4 text-[9px]">●</span>
              <span className="font-mono text-[10px] text-ink-3">2.1s</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {MOCK_EXTRACTION.map((f) => (
              <div
                key={f.name}
                className={`px-4 py-3 border-b border-dotted border-border ${f.name === "total_amount" ? "bg-vermillion-3/50 border-l-[3px] border-l-vermillion-2 pl-[calc(1rem-3px)]" : ""}`}
              >
                <div className="flex items-baseline justify-between mb-0.5">
                  <span className="font-mono text-[11px] text-vermillion-2 font-medium">{f.name}</span>
                  <span className="font-mono text-[9.5px] text-green">{f.confidence.toFixed(2)}</span>
                </div>
                <div className="font-mono text-[12px] text-ink">{f.value}</div>
              </div>
            ))}
          </div>
          <div className="px-3.5 py-3 border-t border-border bg-cream-2">
            <div className="text-[12.5px] text-ink-2 mb-2">
              Ready to build your own? Save this schema to a project and run on your own endpoint.
            </div>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors w-full justify-center">
              Save to project →
            </button>
          </div>
        </div>,
      ]}
    />
  );
}
