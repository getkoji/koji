"use client";

import { useState, useCallback, useEffect } from "react";
import { StickyHeader, Breadcrumbs, PageHeader } from "@/components/layouts";
import { me as meApi } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { TableSkeleton } from "@/components/shared/TableSkeleton";

export default function AccountPage() {
  const { data: user, loading, error } = useApi(useCallback(() => meApi.get(), []));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Populate form when user data arrives
  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setEmail(user.email);
    }
  }, [user]);

  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() || "?";

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await meApi.update({ name, email });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      // TODO: show error toast
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs items={[{ label: "Account" }]} />
        <PageHeader title="Account" />
      </StickyHeader>
      <div className="flex-1 overflow-y-auto px-10 pt-6 pb-8 max-w-2xl">
        {loading ? (
          <TableSkeleton columns={2} rows={4} />
        ) : error ? (
          <div className="text-[13px] text-vermillion-2">{error}</div>
        ) : (
          <>
            {/* Profile */}
            <section className="mb-10">
              <h3 className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-4">
                Profile
              </h3>
              <div className="space-y-4">
                <div className="flex items-center gap-5 mb-6">
                  <div className="w-16 h-16 rounded-full bg-vermillion-2 text-cream font-mono text-xl font-medium inline-flex items-center justify-center shrink-0">
                    {initials}
                  </div>
                  <div>
                    <div className="text-[15px] font-medium text-ink">{name || "—"}</div>
                    <div className="font-mono text-[12px] text-ink-3 mt-0.5">{email}</div>
                    <div className="font-mono text-[10px] text-ink-4 mt-1">
                      Joined {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-medium text-ink">Display name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-medium text-ink">Email</label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
                  />
                  <p className="text-[11px] text-ink-4">Used for login and notifications.</p>
                </div>

                <div className="flex items-center gap-3 mt-2">
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50 min-w-[120px] justify-center"
                  >
                    {saving ? (
                      <>
                        <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Saving
                      </>
                    ) : saved ? (
                      <>
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Saved
                      </>
                    ) : (
                      "Save changes"
                    )}
                  </button>
                </div>
              </div>
            </section>

            {/* Password */}
            <PasswordSection />

            {/* Danger zone */}
            <section>
              <h3 className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-vermillion-2 mb-4">
                Danger zone
              </h3>
              <div className="border border-vermillion-2/25 rounded-sm p-4 bg-vermillion-3/30">
                <div className="text-[13px] font-medium text-ink mb-1">Delete account</div>
                <p className="text-[12px] text-ink-3 mb-3">
                  Permanently remove your account and all associated data. This cannot be undone.
                </p>
                <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors">
                  Delete account
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPw, setChangingPw] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  async function handlePasswordChange() {
    setPwError(null);
    if (newPassword.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    setChangingPw(true);
    setPwSaved(false);
    try {
      await meApi.updatePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setPwSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setTimeout(() => setPwSaved(false), 2000);
    } catch (err: unknown) {
      setPwError(err instanceof Error ? err.message : "Failed to update password.");
    } finally {
      setChangingPw(false);
    }
  }

  return (
    <section className="mb-10">
      <h3 className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-4">
        Password
      </h3>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-[12.5px] font-medium text-ink">Current password</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[12.5px] font-medium text-ink">New password</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
          />
        </div>
        {pwError && (
          <div className="text-[12.5px] text-vermillion-2 bg-vermillion-3/50 px-3 py-2 rounded-sm">
            {pwError}
          </div>
        )}
        <button
          onClick={handlePasswordChange}
          disabled={changingPw || !currentPassword || !newPassword}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors disabled:opacity-50 min-w-[150px] justify-center"
        >
          {changingPw ? (
            <>
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Updating...
            </>
          ) : pwSaved ? (
            <>
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Updated
            </>
          ) : (
            "Update password"
          )}
        </button>
      </div>
    </section>
  );
}
