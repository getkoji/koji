"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, Bell, User, Settings, LogOut, Moon, HelpCircle, ExternalLink } from "lucide-react";
import { KojiLogo } from "./KojiLogo";
import { me as meApi, type UserProfile } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export function TopBar({ tenantSlug: tenantSlugProp }: { tenantSlug?: string }) {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? tenantSlugProp;
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { data: user } = useApi(useCallback(() => meApi.get(), []));

  const userName = user?.name ?? "User";
  const userEmail = user?.email ?? "";
  const userInitials = userName.split(" ").map(n => n[0]).join("").toUpperCase() || "?";

  // Close on click outside
  useEffect(() => {
    if (!userMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [userMenuOpen]);

  // Close on escape
  useEffect(() => {
    if (!userMenuOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setUserMenuOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [userMenuOpen]);

  return (
    <header
      className="grid items-center h-[60px] px-5 bg-cream border-b border-border sticky top-0 z-30"
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

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className={`w-[30px] h-[30px] rounded-full bg-vermillion-2 text-cream font-mono text-[11px] font-medium inline-flex items-center justify-center transition-opacity ${userMenuOpen ? "opacity-80" : "hover:opacity-90"}`}
            aria-label="User menu"
            aria-expanded={userMenuOpen}
          >
            {userInitials}
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-[38px] w-[220px] bg-white border border-border-strong rounded-sm shadow-lg overflow-hidden z-50">
              {/* User info */}
              <div className="px-3.5 py-3 border-b border-border">
                <div className="text-[13px] font-medium text-ink">{userName}</div>
                <div className="font-mono text-[11px] text-ink-3 mt-0.5">{userEmail}</div>
              </div>

              {/* Menu items */}
              <div className="py-1">
                <UserMenuItem
                  icon={<User className="w-3.5 h-3.5" />}
                  label="Account"
                  href={tenantSlug ? `/t/${tenantSlug}/account` : "/account"}
                />
                <UserMenuItem
                  icon={<Settings className="w-3.5 h-3.5" />}
                  label="Settings"
                  href={tenantSlug ? `/t/${tenantSlug}/settings` : "/settings"}
                />
                <UserMenuItem
                  icon={<Moon className="w-3.5 h-3.5" />}
                  label="Appearance"
                  onClick={() => {/* TODO: theme toggle */}}
                />
              </div>

              <div className="border-t border-border py-1">
                <UserMenuItem
                  icon={<HelpCircle className="w-3.5 h-3.5" />}
                  label="Documentation"
                  href="https://getkoji.dev/docs"
                  external
                />
                <UserMenuItem
                  icon={<ExternalLink className="w-3.5 h-3.5" />}
                  label="API reference"
                  href="https://getkoji.dev/docs/reference/api"
                  external
                />
              </div>

              <div className="border-t border-border py-1">
                <UserMenuItem
                  icon={<LogOut className="w-3.5 h-3.5" />}
                  label="Sign out"
                  onClick={() => {/* TODO: auth sign out */}}
                  danger
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function UserMenuItem({
  icon,
  label,
  href,
  external,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  danger?: boolean;
}) {
  const className = `flex items-center gap-2.5 w-full px-3.5 py-2 text-[12.5px] transition-colors ${
    danger
      ? "text-vermillion-2 hover:bg-vermillion-3/50"
      : "text-ink-2 hover:bg-cream-2 hover:text-ink"
  }`;

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
          <span className="text-ink-4">{icon}</span>
          <span>{label}</span>
          <ExternalLink className="w-3 h-3 ml-auto text-ink-4" />
        </a>
      );
    }
    return (
      <Link href={href} className={className}>
        <span className="text-ink-4">{icon}</span>
        <span>{label}</span>
      </Link>
    );
  }

  return (
    <button onClick={onClick} className={className}>
      <span className="text-ink-4">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
