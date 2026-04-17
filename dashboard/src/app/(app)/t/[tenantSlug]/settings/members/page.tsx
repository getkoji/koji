"use client";

import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "../_components";

const TEAM_MEMBERS = [
  { name: "Frank Thomas", email: "frank.thomas@superkey.com", role: "Owner", lastActive: "now" },
  { name: "Sarah Kim", email: "sarah.kim@superkey.com", role: "Admin", lastActive: "3h ago" },
  { name: "James Chen", email: "james.chen@superkey.com", role: "Member", lastActive: "yesterday" },
];

export default function MembersPage() {
  return (
    <section>
      <SectionHeader title="Members" action={{ label: "Invite member" }} />
      <SettingsTable>
        {TEAM_MEMBERS.map((m) => (
          <SettingsRow key={m.email}>
            <div className="flex items-center gap-4">
              <span className="text-[12.5px] text-ink font-medium">{m.name}</span>
              <span className="font-mono text-[11px] text-ink-3">{m.email}</span>
            </div>
            <div className="flex items-center gap-4">
              <Badge>{m.role}</Badge>
              <Meta>{m.lastActive}</Meta>
            </div>
          </SettingsRow>
        ))}
      </SettingsTable>
    </section>
  );
}
