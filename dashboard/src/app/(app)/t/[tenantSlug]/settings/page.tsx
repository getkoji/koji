"use client";

import { Breadcrumbs, PageHeader, StickyHeader } from "@/components/layouts";

const ENDPOINTS = [
  { url: "https://api.acme-invoices.getkoji.dev/extract", env: "production", status: "active" },
  { url: "https://api.acme-invoices.getkoji.dev/staging/extract", env: "staging", status: "active" },
];

const API_KEYS = [
  { name: "Production key", prefix: "koji_live_...a8f2", created: "2026-03-01", lastUsed: "2 min ago" },
  { name: "Staging key", prefix: "koji_test_...c4d1", created: "2026-03-15", lastUsed: "1h ago" },
  { name: "CI / CD", prefix: "koji_test_...e7b3", created: "2026-04-02", lastUsed: "yesterday" },
];

const TEAM_MEMBERS = [
  { name: "Frank Thomas", email: "frank.thomas@superkey.com", role: "Owner", lastActive: "now" },
  { name: "Sarah Kim", email: "sarah.kim@superkey.com", role: "Admin", lastActive: "3h ago" },
  { name: "James Chen", email: "james.chen@superkey.com", role: "Member", lastActive: "yesterday" },
];

const WEBHOOKS = [
  { url: "https://hooks.slack.com/triggers/T02.../A06...", events: "job.complete, job.failed", status: "active" },
  { url: "https://api.internal.acme.com/koji-callback", events: "review.created", status: "active" },
];

function SectionHeader({ title, action }: { title: string; action?: { label: string } }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">{title}</span>
      {action && (
        <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
          {action.label}
        </button>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs items={[{ label: "acme-invoices", href: "#" }, { label: "Settings" }]} />
        <PageHeader title="Settings" />
      </StickyHeader>

      <div className="flex-1 overflow-y-auto px-10 pt-6 pb-8 space-y-10">
        {/* Endpoints */}
        <section>
          <SectionHeader title="Endpoints" />
          <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
            {ENDPOINTS.map((e) => (
              <div key={e.url} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] text-ink">{e.url}</span>
                  <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-cream-2 text-ink-3">{e.env}</span>
                </div>
                <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-green/[0.12] text-green">{e.status}</span>
              </div>
            ))}
          </div>
        </section>

        {/* API Keys */}
        <section>
          <SectionHeader title="API Keys" action={{ label: "Create key" }} />
          <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
            {API_KEYS.map((k) => (
              <div key={k.prefix} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-4">
                  <span className="text-[12.5px] text-ink font-medium">{k.name}</span>
                  <span className="font-mono text-[11px] text-ink-3">{k.prefix}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-mono text-[10px] text-ink-4">created {k.created}</span>
                  <span className="font-mono text-[10px] text-ink-4">used {k.lastUsed}</span>
                  <button className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors">revoke</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Team */}
        <section>
          <SectionHeader title="Team" action={{ label: "Invite member" }} />
          <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
            {TEAM_MEMBERS.map((m) => (
              <div key={m.email} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-4">
                  <span className="text-[12.5px] text-ink font-medium">{m.name}</span>
                  <span className="font-mono text-[11px] text-ink-3">{m.email}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-cream-2 text-ink-3">{m.role}</span>
                  <span className="font-mono text-[10px] text-ink-4">{m.lastActive}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Webhooks */}
        <section>
          <SectionHeader title="Webhooks" action={{ label: "Add webhook" }} />
          <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
            {WEBHOOKS.map((w) => (
              <div key={w.url} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-4">
                  <span className="font-mono text-[11px] text-ink">{w.url}</span>
                  <span className="font-mono text-[10px] text-ink-4">{w.events}</span>
                </div>
                <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-green/[0.12] text-green">{w.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
