"use client";

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { usePageTitle } from "@/lib/use-page-title";

// Project-scoped roles (oss-372).
const PROJECT_ROLES = [
  { value: "project-viewer", label: "Viewer" },
  { value: "project-member", label: "Member" },
  { value: "project-editor", label: "Editor" },
  { value: "project-admin", label: "Admin" },
];

interface ProjectMember {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  access: "granted" | "all";
  roles: string[];
  // access:"all" only — admins are all-access by design (not editable here);
  // defaultRole is the project role their workspace role maps to.
  workspaceAdmin?: boolean;
  defaultRole?: string;
}
interface Candidate {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
}
interface MembersResponse {
  project: { slug: string; displayName: string };
  members: ProjectMember[];
  candidates: Candidate[];
}

function roleLabel(role: string): string {
  return PROJECT_ROLES.find((r) => r.value === role)?.label ?? role;
}

export default function ProjectMembersPage() {
  usePageTitle("Project Members");
  const params = useParams<{ projectSlug: string }>();
  const projectSlug = params?.projectSlug ?? "";
  const { hasPermission } = useAuth();
  const canManage = hasPermission("member:invite");

  const { data, loading, error, refetch } = useApi(
    useCallback(
      () => api.get<MembersResponse>(`/api/projects/${projectSlug}/members`),
      [projectSlug],
    ),
  );

  const [showAdd, setShowAdd] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ProjectMember | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function changeRole(m: ProjectMember, role: string) {
    setRowError(null);
    try {
      await api.put(`/api/projects/${projectSlug}/members/${m.membershipId}`, { roles: [role] });
      await refetch();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to update role");
    }
  }

  async function removeMember(m: ProjectMember) {
    setBusy(true);
    try {
      await api.delete(`/api/projects/${projectSlug}/members/${m.membershipId}`);
      await refetch();
      setConfirmRemove(null);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section>
        <SectionHeader title="Members" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading…</div>
      </section>
    );
  }
  if (error) {
    return (
      <section>
        <SectionHeader title="Members" />
        <div className="text-[12.5px] text-vermillion-2 py-4">{error.message}</div>
      </section>
    );
  }

  const members = data?.members ?? [];
  const candidates = data?.candidates ?? [];

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          title="Members"
          action={canManage && candidates.length > 0 ? { label: "Add member", onClick: () => setShowAdd(true) } : undefined}
        />
        <p className="text-[12.5px] text-ink-3 mb-3 max-w-[70ch]">
          Who can access <span className="font-medium text-ink">{data?.project.displayName}</span> and their role here.
          Workspace owners and admins always have access to every project.
        </p>

        {rowError && (
          <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mb-3">{rowError}</div>
        )}

        {members.length === 0 ? (
          <div className="text-[12.5px] text-ink-3 border border-border rounded-sm p-4 text-center">
            No members have access to this project yet.
          </div>
        ) : (
          <SettingsTable>
            {members.map((m) => (
              <SettingsRow key={m.membershipId}>
                <div className="flex items-center gap-4">
                  <span className="text-[12.5px] text-ink font-medium">{m.name ?? m.email.split("@")[0]}</span>
                  <span className="font-mono text-[11px] text-ink-3">{m.email}</span>
                </div>
                <div className="flex items-center gap-3">
                  {m.access === "all" && m.workspaceAdmin ? (
                    <Badge>All projects · {m.roles[0] ?? "admin"}</Badge>
                  ) : canManage ? (
                    <>
                      {m.access === "all" && <Meta>all projects</Meta>}
                      <select
                        value={(m.access === "all" ? m.defaultRole : m.roles[0]) ?? "project-member"}
                        onChange={(e) => changeRole(m, e.target.value)}
                        aria-label={`Project role for ${m.email}`}
                        className="h-[26px] rounded-sm border border-input bg-white px-1.5 text-[11.5px] outline-none focus:border-ring"
                      >
                        {PROJECT_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => setConfirmRemove(m)}
                        className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors"
                      >
                        remove
                      </button>
                    </>
                  ) : m.access === "all" ? (
                    <Badge>All projects · {m.roles[0] ?? "member"}</Badge>
                  ) : (
                    <Badge>{roleLabel(m.roles[0] ?? "project-member")}</Badge>
                  )}
                </div>
              </SettingsRow>
            ))}
          </SettingsTable>
        )}
      </section>

      {showAdd && (
        <AddMemberDialog
          projectSlug={projectSlug}
          candidates={candidates}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); refetch(); }}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove from project"
          description={
            confirmRemove.access === "all"
              ? `${confirmRemove.name ?? confirmRemove.email} currently has access to all projects. Removing them here switches them to project-specific access — they'll keep their access to every other project and lose this one.`
              : `Remove ${confirmRemove.name ?? confirmRemove.email} from this project? They'll lose access to it.`
          }
          confirmLabel={busy ? "Removing…" : "Remove"}
          onConfirm={() => removeMember(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

function AddMemberDialog({
  projectSlug,
  candidates,
  onClose,
  onAdded,
}: {
  projectSlug: string;
  candidates: Candidate[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [membershipId, setMembershipId] = useState(candidates[0]?.membershipId ?? "");
  const [role, setRole] = useState("project-member");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    if (!membershipId) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/projects/${projectSlug}/members/${membershipId}`, { roles: [role] });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Add a member to this project</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Grant a workspace member access to this project with a role. Only members not
          already on the project (and not workspace admins) appear here.
        </p>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Member</label>
            <select
              value={membershipId}
              onChange={(e) => setMembershipId(e.target.value)}
              aria-label="Member"
              className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring"
            >
              {candidates.map((c) => (
                <option key={c.membershipId} value={c.membershipId}>
                  {(c.name ?? c.email.split("@")[0])} — {c.email}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Role in this project</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Role in this project"
              className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring"
            >
              {PROJECT_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={saving || !membershipId}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {saving ? "Adding…" : "Add member"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
