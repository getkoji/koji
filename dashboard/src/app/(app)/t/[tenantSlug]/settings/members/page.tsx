"use client";

import { useState, useCallback, useRef } from "react";
import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";

interface Member {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

interface Invite {
  id: string;
  email: string;
  roles: string[];
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  invitedBy: string;
}

const AVAILABLE_ROLES = [
  { value: "viewer", label: "Viewer" },
  { value: "runner", label: "Runner" },
  { value: "reviewer", label: "Reviewer" },
  { value: "schema-editor", label: "Schema Editor" },
  { value: "schema-deployer", label: "Schema Deployer" },
  { value: "tenant-admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

function roleLabel(roles: string[]): string {
  const order = AVAILABLE_ROLES.map((r) => r.value);
  let highest = roles[0] ?? "viewer";
  for (const r of roles) {
    if (order.indexOf(r) > order.indexOf(highest)) highest = r;
  }
  return AVAILABLE_ROLES.find((r) => r.value === highest)?.label ?? highest;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isExpired(dateStr: string): boolean {
  return new Date(dateStr).getTime() < Date.now();
}

export default function MembersPage() {
  const { hasPermission, user } = useAuth();
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [accessMember, setAccessMember] = useState<Member | null>(null);

  const { data: members, loading: membersLoading, error: membersError, refetch: refetchMembers } = useApi(
    useCallback(() => api.get<{ data: Member[] }>("/api/members").then((r) => r.data), []),
  );

  const { data: allInvites, loading: invitesLoading, refetch: refetchInvites } = useApi(
    useCallback(() => api.get<{ data: Invite[] }>("/api/invites").then((r) => r.data), []),
  );

  const pendingInvites = (allInvites ?? []).filter((i) => !i.acceptedAt && !isExpired(i.expiresAt));

  // Confirmation dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  function requestRemoveMember(member: Member) {
    setConfirmDialog({
      title: "Remove member",
      description: `Remove ${member.name ?? member.email} from this workspace? They will lose access immediately.`,
      confirmLabel: "Remove",
      onConfirm: async () => {
        await api.delete(`/api/members/${member.id}`);
        refetchMembers();
      },
    });
  }

  function requestRevokeInvite(invite: Invite) {
    setConfirmDialog({
      title: "Revoke invitation",
      description: `Revoke the pending invite to ${invite.email}? The invite link will stop working.`,
      confirmLabel: "Revoke",
      onConfirm: async () => {
        await api.delete(`/api/invites/${invite.id}`);
        refetchInvites();
      },
    });
  }

  if (membersLoading) {
    return (
      <section>
        <SectionHeader title="Members" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
      </section>
    );
  }

  if (membersError) {
    return (
      <section>
        <SectionHeader title="Members" />
        <div className="text-[12.5px] text-vermillion-2 py-4">{membersError.message}</div>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      {/* Active members */}
      <section>
        <SectionHeader title="Members" />
        <SettingsTable>
          {(members ?? []).map((m) => (
            <SettingsRow key={m.id}>
              <div className="flex items-center gap-4">
                <span className="text-[12.5px] text-ink font-medium">{m.name ?? m.email.split("@")[0]}</span>
                <span className="font-mono text-[11px] text-ink-3">{m.email}</span>
                {m.userId === user?.id && (
                  <span className="font-mono text-[10px] text-ink-4 bg-cream-2 px-1.5 py-0.5 rounded-sm">you</span>
                )}
              </div>
              <div className="flex items-center gap-4">
                <Badge>{roleLabel(m.roles)}</Badge>
                <Meta>{timeAgo(m.lastLoginAt)}</Meta>
                {hasPermission("member:invite") && (
                  <button
                    onClick={() => setAccessMember(m)}
                    className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors"
                  >
                    project access
                  </button>
                )}
                {hasPermission("member:remove") && m.userId !== user?.id && (
                  <button
                    onClick={() => requestRemoveMember(m)}
                    className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors"
                  >
                    remove
                  </button>
                )}
              </div>
            </SettingsRow>
          ))}
        </SettingsTable>
      </section>

      {/* Pending invitations */}
      <section>
        <SectionHeader
          title="Pending invitations"
          action={hasPermission("member:invite") ? { label: "Invite member", onClick: () => setShowInviteDialog(true) } : undefined}
        />

        {pendingInvites.length > 0 ? (
          <SettingsTable>
            {pendingInvites.map((invite) => (
              <SettingsRow key={invite.id}>
                <div className="flex items-center gap-4">
                  <span className="font-mono text-[12px] text-ink">{invite.email}</span>
                  <Badge>{roleLabel(invite.roles)}</Badge>
                </div>
                <div className="flex items-center gap-4">
                  <Meta>invited by {invite.invitedBy}</Meta>
                  <Meta>expires {timeAgo(invite.expiresAt).replace(" ago", "")}</Meta>
                  {hasPermission("member:invite") && (
                    <button
                      onClick={() => requestRevokeInvite(invite)}
                      className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors"
                    >
                      revoke
                    </button>
                  )}
                </div>
              </SettingsRow>
            ))}
          </SettingsTable>
        ) : (
          !invitesLoading && (
            <div className="border border-border rounded-sm py-6 text-center text-[12.5px] text-ink-3">
              No pending invitations
            </div>
          )
        )}
      </section>

      {/* Invite dialog */}
      {showInviteDialog && (
        <InviteDialog
          onClose={() => setShowInviteDialog(false)}
          onSuccess={() => { refetchInvites(); setShowInviteDialog(false); }}
        />
      )}

      {accessMember && (
        <ProjectAccessDialog
          member={accessMember}
          onClose={() => setAccessMember(null)}
          onSaved={() => setAccessMember(null)}
        />
      )}

      {/* Confirmation dialog */}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={async () => {
            await confirmDialog.onConfirm();
            setConfirmDialog(null);
          }}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

function InviteDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);

    try {
      await api.post("/api/invites", { email, roles: [role] });
      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Invite a team member</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          They'll receive an email with a link to join this workspace.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Email address</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              autoFocus
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
            >
              {AVAILABLE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-ink-4">
              {role === "viewer" && "Can view schemas, jobs, and data. Cannot make changes."}
              {role === "runner" && "Can run jobs and use the playground."}
              {role === "reviewer" && "Can approve review items and promote corpus entries."}
              {role === "schema-editor" && "Can edit and validate schemas."}
              {role === "schema-deployer" && "Can deploy schemas and manage pipelines."}
              {role === "tenant-admin" && "Full access except deleting the organization."}
              {role === "owner" && "Full access including organization deletion and transfer."}
            </p>
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sending}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {sending ? "Sending..." : "Send invite"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Per-member project access. A member is either unrestricted (all projects) or
 * limited to a chosen set. Their tenant role applies wherever they can reach.
 */
function ProjectAccessDialog({
  member,
  onClose,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: allProjects } = useApi(
    useCallback(
      () => api.get<{ data: Array<{ slug: string; displayName: string }> }>("/api/projects").then((r) => r.data),
      [],
    ),
  );
  const { data: current, loading } = useApi(
    useCallback(
      () => api.get<{ restricted: boolean; projects: Array<{ slug: string }> }>(`/api/members/${member.id}/project-access`),
      [member.id],
    ),
  );

  const [restricted, setRestricted] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);

  // Seed local state once the current setting loads.
  if (current && !initialized.current) {
    initialized.current = true;
    setRestricted(current.restricted);
    setSelected(new Set(current.projects.map((p) => p.slug)));
  }

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/members/${member.id}/project-access`, {
        restricted,
        project_slugs: restricted ? [...selected] : [],
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[440px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Project access</h2>
        <p className="text-[12.5px] text-ink-3 mb-4">
          Control which projects <span className="font-medium text-ink">{member.name ?? member.email}</span> can access.
          Their role ({roleLabel(member.roles)}) applies in every project they can reach.
        </p>

        {loading ? (
          <div className="font-mono text-[11px] text-ink-4 py-4">Loading…</div>
        ) : (
          <div className="space-y-3 mb-4">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                checked={!restricted}
                onChange={() => setRestricted(false)}
                className="mt-0.5"
              />
              <span>
                <span className="text-[13px] text-ink font-medium block">All projects</span>
                <span className="text-[12px] text-ink-3">Access to every project, including ones created later.</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                checked={restricted}
                onChange={() => setRestricted(true)}
                className="mt-0.5"
              />
              <span>
                <span className="text-[13px] text-ink font-medium block">Only specific projects</span>
                <span className="text-[12px] text-ink-3">Access limited to the projects you choose.</span>
              </span>
            </label>

            {restricted && (
              <div className="border border-border rounded-sm p-2 max-h-[220px] overflow-y-auto space-y-1 ml-6">
                {(allProjects ?? []).length === 0 ? (
                  <div className="text-[12px] text-ink-4 px-1 py-1">No projects.</div>
                ) : (
                  (allProjects ?? []).map((p) => (
                    <label key={p.slug} className="flex items-center gap-2 px-1 py-1 rounded-sm hover:bg-cream-2 cursor-pointer">
                      <input type="checkbox" checked={selected.has(p.slug)} onChange={() => toggle(p.slug)} />
                      <span className="text-[12.5px] text-ink truncate">{p.displayName}</span>
                      <span className="font-mono text-[10.5px] text-ink-4">{p.slug}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mb-4">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading || (restricted && selected.size === 0)}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

