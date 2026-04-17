"use client";

import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";

const REVIEW_ITEMS = [
  { field: "policy_number", document: "claim-2026-04-0891.pdf", reason: "low-confidence", confidence: "0.62", assigned: "Frank T.", age: "4 min ago" },
  { field: "total_amount", document: "invoice-acme-0042.pdf", reason: "conflicting-values", confidence: "0.71", assigned: "Unassigned", age: "12 min ago" },
  { field: "effective_date", document: "renewal-notice-q2.pdf", reason: "ambiguous-format", confidence: "0.58", assigned: "Sarah K.", age: "28 min ago" },
  { field: "beneficiary_name", document: "claim-2026-04-0887.pdf", reason: "low-confidence", confidence: "0.45", assigned: "Unassigned", age: "1h ago" },
  { field: "line_items[3].desc", document: "invoice-globex-119.pdf", reason: "truncated-value", confidence: "0.67", assigned: "Frank T.", age: "2h ago" },
  { field: "diagnosis_code", document: "claim-2026-04-0884.pdf", reason: "validation-failed", confidence: "0.83", assigned: "Unassigned", age: "3h ago" },
];

export default function ReviewPage() {
  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: "acme-invoices", href: "#" }, { label: "Review" }]} />
          <PageHeader
            title="Review queue"
            meta={<span>6 items need attention</span>}
            actions={
              <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
                Assign all to me
              </button>
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {["All", "Unassigned", "Mine", "Resolved"].map((s) => (
            <button
              key={s}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${s === "All" ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"}`}
            >
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">6 pending</span>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {["Field", "Document", "Reason", "Confidence", "Assigned", "Age"].map((h) => (
              <th
                key={h}
                className={`text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 ${h === "Confidence" ? "text-right" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {REVIEW_ITEMS.map((r) => (
            <tr key={r.field + r.document} className="border-b border-dotted border-border hover:bg-cream-2/50 cursor-pointer transition-colors">
              <td className="px-4 py-2 font-mono text-[11px] text-vermillion-2">{r.field}</td>
              <td className="px-4 py-2 text-[12.5px] text-ink-2">{r.document}</td>
              <td className="px-4 py-2">
                <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-cream-2 text-ink-3">
                  {r.reason}
                </span>
              </td>
              <td className="px-4 py-2 text-right font-mono text-[11px] text-ink">{r.confidence}</td>
              <td className="px-4 py-2 text-[12.5px] text-ink-2">{r.assigned}</td>
              <td className="px-4 py-2 font-mono text-[10px] text-ink-4">{r.age}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}
