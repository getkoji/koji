"use client";

import { SectionHeader, SettingsTable, SettingsRow, Badge } from "../_components";

const ENDPOINTS = [
  { url: "https://api.acme-invoices.getkoji.dev/extract", env: "production", status: "active" },
  { url: "https://api.acme-invoices.getkoji.dev/staging/extract", env: "staging", status: "active" },
];

export default function EndpointsPage() {
  return (
    <section>
      <SectionHeader title="Model Endpoints" action={{ label: "Add endpoint" }} />
      <SettingsTable>
        {ENDPOINTS.map((e) => (
          <SettingsRow key={e.url}>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-ink">{e.url}</span>
              <Badge>{e.env}</Badge>
            </div>
            <Badge variant="active">{e.status}</Badge>
          </SettingsRow>
        ))}
      </SettingsTable>
    </section>
  );
}
