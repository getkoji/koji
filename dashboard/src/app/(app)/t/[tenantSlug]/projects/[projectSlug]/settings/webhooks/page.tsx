"use client";

import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";

const WEBHOOKS = [
  { url: "https://hooks.slack.com/triggers/T02.../A06...", events: "job.complete, job.failed", status: "active" },
  { url: "https://api.internal.acme.com/koji-callback", events: "review.created", status: "active" },
];

export default function WebhooksPage() {
  return (
    <section>
      <SectionHeader title="Webhooks" action={{ label: "Add webhook" }} />
      <SettingsTable>
        {WEBHOOKS.map((w) => (
          <SettingsRow key={w.url}>
            <div className="flex items-center gap-4">
              <span className="font-mono text-[11px] text-ink">{w.url}</span>
              <Meta>{w.events}</Meta>
            </div>
            <Badge variant="active">{w.status}</Badge>
          </SettingsRow>
        ))}
      </SettingsTable>
    </section>
  );
}
