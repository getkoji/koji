"use client";

import Link from "next/link";
import { Search, Bell } from "lucide-react";
import { KojiLogo } from "./KojiLogo";

export function TopBar({ tenantSlug }: { tenantSlug?: string }) {
  return (
    <header
      className="grid items-center h-[60px] px-5 bg-cream border-b border-border sticky top-0 z-10"
      style={{ gridTemplateColumns: "256px 1fr auto" }}
    >
      {/* Brand + project switcher */}
      <div className="flex items-center gap-2.5">
        <Link href="/" className="flex items-center gap-2.5 hover:opacity-70 transition-opacity">
          <KojiLogo className="w-[26px] h-[26px] text-ink" />
          <span className="font-display text-2xl font-medium tracking-tight text-ink leading-none"
                style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}>
            koji
          </span>
        </Link>
        {tenantSlug && (
          <>
            <span className="text-cream-4 text-[22px] font-light px-1">/</span>
            <button
              className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-2 px-2 py-1.5 rounded-sm hover:bg-cream-2 transition-colors"
              type="button"
            >
              <span>{tenantSlug}</span>
              <span className="text-ink-4 text-[10px]">▾</span>
            </button>
          </>
        )}
      </div>

      {/* Universal trace bar */}
      <div className="justify-self-center w-full max-w-[520px] flex items-center gap-2 px-3.5 py-2 bg-cream-2 border border-border rounded-sm focus-within:border-vermillion-2 focus-within:bg-cream transition-colors">
        <span className="font-mono text-vermillion-2 text-[13px] font-semibold">↳</span>
        <input
          type="text"
          placeholder="paste a doc id, file hash, webhook id, correlation id…"
          className="flex-1 bg-transparent border-none outline-none font-mono text-xs text-ink placeholder:text-ink-4"
        />
        <kbd className="font-mono text-[10px] text-ink-4 px-1.5 py-0.5 border border-border rounded-sm bg-cream">
          ⌘K
        </kbd>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1.5">
        <button
          className="w-8 h-8 inline-flex items-center justify-center rounded-sm text-ink-3 hover:bg-cream-2 hover:text-ink transition-colors"
          aria-label="Search"
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          className="w-8 h-8 inline-flex items-center justify-center rounded-sm text-ink-3 hover:bg-cream-2 hover:text-ink transition-colors"
          aria-label="Notifications"
        >
          <Bell className="w-4 h-4" />
        </button>
        <button
          className="w-[30px] h-[30px] rounded-full bg-vermillion-2 text-cream font-mono text-[11px] font-medium inline-flex items-center justify-center"
          aria-label="User menu"
        >
          FT
        </button>
      </div>
    </header>
  );
}
