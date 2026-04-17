"use client";

import { SectionHeader } from "../_components";

export default function BillingPage() {
  return (
    <section className="space-y-8">
      <div>
        <SectionHeader title="Current Plan" action={{ label: "Manage plan" }} />
        <div className="border border-border rounded-sm p-5 flex items-start justify-between">
          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[18px] font-medium text-ink font-display">Scale</span>
              <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-green/[0.12] text-green">Active</span>
            </div>
            <p className="text-[13px] text-ink-3">$499/month · 5,000 docs included · $0.08/doc overage</p>
            <p className="text-[12px] text-ink-4">Next billing: May 1, 2026</p>
          </div>
        </div>
      </div>

      <div>
        <SectionHeader title="Usage This Period" />
        <div className="border border-border rounded-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-3">Documents processed</span>
            <span className="font-mono text-[12px] text-ink font-medium">3,247 / 5,000</span>
          </div>
          <div className="w-full bg-cream-2 rounded-full h-1.5">
            <div className="bg-vermillion-2 h-1.5 rounded-full" style={{ width: "64.9%" }} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-3">Overage</span>
            <span className="font-mono text-[12px] text-ink font-medium">$0.00</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-3">Credited (infrastructure issues)</span>
            <span className="font-mono text-[12px] text-ink font-medium">0 docs</span>
          </div>
        </div>
      </div>

      <div>
        <SectionHeader title="Inference Cost (paid to your AI provider)" />
        <div className="border border-border rounded-sm p-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-3">Estimated this period</span>
            <span className="font-mono text-[12px] text-ink font-medium">$24.18</span>
          </div>
          <p className="text-[11px] text-ink-4 mt-2">This cost is billed directly by your model provider, not by Koji.</p>
        </div>
      </div>
    </section>
  );
}
