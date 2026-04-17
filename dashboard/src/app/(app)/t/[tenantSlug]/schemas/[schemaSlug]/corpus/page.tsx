"use client";

import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";

const CORPUS_ITEMS = [
  { filename: "invoice-acme-0042.pdf", tags: ["normal", "regression"], pass: "pass", gt: "verified", added: "2 days ago" },
  { filename: "claim-handwritten-scan.tiff", tags: ["adversarial", "edge"], pass: "fail", gt: "verified", added: "3 days ago" },
  { filename: "receipt-faded-thermal.jpg", tags: ["edge"], pass: "pass", gt: "verified", added: "4 days ago" },
  { filename: "invoice-multilang-de.pdf", tags: ["edge", "regression"], pass: "pass", gt: "pending", added: "5 days ago" },
  { filename: "eob-complex-table.pdf", tags: ["adversarial"], pass: "fail", gt: "verified", added: "1 week ago" },
  { filename: "claim-clean-typed.pdf", tags: ["normal"], pass: "pass", gt: "verified", added: "1 week ago" },
  { filename: "invoice-rotated-90.pdf", tags: ["adversarial", "edge"], pass: "pass", gt: "pending", added: "1 week ago" },
  { filename: "receipt-crumpled-photo.jpg", tags: ["adversarial", "regression"], pass: "fail", gt: "verified", added: "2 weeks ago" },
];

const TAG_COLORS: Record<string, string> = {
  normal: "bg-green/[0.12] text-green",
  edge: "bg-cream-2 text-ink-3",
  adversarial: "bg-vermillion-3 text-vermillion-2",
  regression: "bg-cream-2 text-ink-4",
};

export default function CorpusPage() {
  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: "acme-invoices", href: "#" },
              { label: "invoice-v2", href: "#" },
              { label: "Corpus" },
            ]}
          />
          <PageHeader
            title="Corpus"
            meta={<span>8 documents &middot; 3 failing</span>}
            actions={
              <>
                <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
                  Run benchmark
                </button>
                <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
                  Add document
                </button>
              </>
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {["All", "Passing", "Failing", "Pending GT"].map((s) => (
            <button
              key={s}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${s === "All" ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"}`}
            >
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">8 documents</span>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {["Filename", "Tags", "Pass", "Ground truth", "Added"].map((h) => (
              <th key={h} className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CORPUS_ITEMS.map((c) => (
            <tr key={c.filename} className="border-b border-dotted border-border hover:bg-cream-2/50 cursor-pointer transition-colors">
              <td className="px-4 py-2 font-mono text-[11px] text-ink">{c.filename}</td>
              <td className="px-4 py-2">
                <div className="flex items-center gap-1">
                  {c.tags.map((t) => (
                    <span
                      key={t}
                      className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${TAG_COLORS[t] || "bg-cream-2 text-ink-4"}`}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2">
                <span
                  className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${
                    c.pass === "pass" ? "bg-green/[0.12] text-green" : "bg-vermillion-3 text-vermillion-2"
                  }`}
                >
                  {c.pass}
                </span>
              </td>
              <td className="px-4 py-2">
                <span
                  className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${
                    c.gt === "verified" ? "bg-green/[0.12] text-green" : "bg-cream-2 text-ink-3"
                  }`}
                >
                  {c.gt}
                </span>
              </td>
              <td className="px-4 py-2 font-mono text-[10px] text-ink-4">{c.added}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}
