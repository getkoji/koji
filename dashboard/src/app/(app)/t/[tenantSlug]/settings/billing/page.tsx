"use client";

import { SectionHeader } from "@/components/shared/SettingsComponents";

export default function BillingPage() {
  return (
    <section>
      <SectionHeader title="Plan & Billing" />
      <div className="border border-border rounded-sm p-6">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <span className="text-[13px] text-ink font-medium">Self-hosted</span>
            <p className="text-[12px] text-ink-3 mt-1">
              You're running Koji on your own infrastructure. No usage limits apply.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
