"use client";

import { useState } from "react";
import { StickyHeader, Breadcrumbs, PageHeader } from "@/components/layouts";

export default function AccountPage() {
  const [name, setName] = useState("Frank Thomas");
  const [email, setEmail] = useState("admin@localhost");

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs items={[{ label: "Account" }]} />
        <PageHeader title="Account" />
      </StickyHeader>
      <div className="flex-1 overflow-y-auto px-10 pt-6 pb-8 max-w-2xl">
        {/* Profile */}
        <section className="mb-10">
          <h3 className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-4">
            Profile
          </h3>
          <div className="space-y-4">
            <div className="flex items-center gap-5 mb-6">
              <div className="w-16 h-16 rounded-full bg-vermillion-2 text-cream font-mono text-xl font-medium inline-flex items-center justify-center shrink-0">
                {name.split(" ").map(n => n[0]).join("")}
              </div>
              <div>
                <div className="text-[15px] font-medium text-ink">{name}</div>
                <div className="font-mono text-[12px] text-ink-3 mt-0.5">{email}</div>
                <button className="font-mono text-[11px] text-vermillion-2 hover:text-ink transition-colors mt-1">
                  Change avatar
                </button>
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

            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors mt-2">
              Save changes
            </button>
          </div>
        </section>

        {/* Password */}
        <section className="mb-10">
          <h3 className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-4">
            Password
          </h3>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Current password</label>
              <input
                type="password"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">New password</label>
              <input
                type="password"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
              />
            </div>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
              Update password
            </button>
          </div>
        </section>

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
      </div>
    </div>
  );
}
