"use client";

import { SectionHeader, SettingsTable, SettingsRow, Meta } from "../_components";

const API_KEYS = [
  { name: "Production key", prefix: "koji_live_...a8f2", created: "2026-03-01", lastUsed: "2 min ago" },
  { name: "Staging key", prefix: "koji_test_...c4d1", created: "2026-03-15", lastUsed: "1h ago" },
  { name: "CI / CD", prefix: "koji_test_...e7b3", created: "2026-04-02", lastUsed: "yesterday" },
];

export default function ApiKeysPage() {
  return (
    <section>
      <SectionHeader title="API Keys" action={{ label: "Create key" }} />
      <SettingsTable>
        {API_KEYS.map((k) => (
          <SettingsRow key={k.prefix}>
            <div className="flex items-center gap-4">
              <span className="text-[12.5px] text-ink font-medium">{k.name}</span>
              <span className="font-mono text-[11px] text-ink-3">{k.prefix}</span>
            </div>
            <div className="flex items-center gap-4">
              <Meta>created {k.created}</Meta>
              <Meta>used {k.lastUsed}</Meta>
              <button className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors">revoke</button>
            </div>
          </SettingsRow>
        ))}
      </SettingsTable>
    </section>
  );
}
