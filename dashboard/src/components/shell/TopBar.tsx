"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { Bell, User, Settings, LogOut, Moon, HelpCircle, ExternalLink, ChevronsUpDown, Plus } from "lucide-react";
import { KojiLogo } from "./KojiLogo";
import { me as meApi, projectsApi, type ProjectRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export function TopBar({ tenantSlug: tenantSlugProp }: { tenantSlug?: string }) {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? tenantSlugProp;
  const router = useRouter();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const { data: user, loading: userLoading } = useApi(useCallback(() => meApi.get(), []));
  const { data: projectList, loading: projectsLoading } = useApi(useCallback(() => projectsApi.list(), []));

  const userName = user?.name ?? "User";
  const userEmail = user?.email ?? "";
  const userInitials = userName.split(" ").map(n => n[0]).join("").toUpperCase() || "?";

  // Close dropdowns on click outside or escape
  useEffect(() => {
    if (!userMenuOpen && !projectMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (userMenuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (projectMenuOpen && projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setUserMenuOpen(false);
        setProjectMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [userMenuOpen, projectMenuOpen]);

  const currentProject = projectList?.find((t) => t.slug === tenantSlug);
  const currentProjectName = currentProject?.displayName;

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
            <div className="relative" ref={projectMenuRef}>
              <button
                onClick={() => !projectsLoading && setProjectMenuOpen(!projectMenuOpen)}
                className={`inline-flex items-center gap-1.5 font-mono text-xs text-ink-2 px-2 py-1.5 rounded-sm transition-colors ${projectMenuOpen ? "bg-cream-2" : "hover:bg-cream-2"}`}
                type="button"
              >
                {projectsLoading ? (
                  <span className="inline-block w-20 h-3 bg-cream-3 rounded-sm animate-pulse" />
                ) : (
                  <span>{currentProjectName}</span>
                )}
                <ChevronsUpDown className="w-3 h-3 text-ink-4" />
              </button>

              {projectMenuOpen && (
                <div className="absolute left-0 top-[34px] w-[240px] bg-white border border-border-strong rounded-sm shadow-lg overflow-hidden z-50">
                  <div className="px-3 py-2 border-b border-border">
                    <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Projects</span>
                  </div>
                  <div className="py-1">
                    {projectList?.map((t) => (
                      <button
                        key={t.slug}
                        onClick={() => {
                          setProjectMenuOpen(false);
                          router.push(`/t/${t.slug}`);
                        }}
                        className={`flex items-center gap-2.5 w-full px-3 py-2 text-[12.5px] transition-colors ${
                          t.slug === tenantSlug
                            ? "bg-cream-2 text-ink font-medium"
                            : "text-ink-2 hover:bg-cream-2 hover:text-ink"
                        }`}
                      >
                        <span className={`w-5 h-5 rounded-sm text-[9px] font-mono font-medium inline-flex items-center justify-center shrink-0 ${
                          t.slug === tenantSlug ? "bg-vermillion-2 text-cream" : "bg-cream-3 text-ink-3"
                        }`}>
                          {t.displayName[0]?.toUpperCase() ?? "?"}
                        </span>
                        <span className="truncate min-w-0">{t.displayName}</span>
                        {t.slug === tenantSlug && (
                          <span className="ml-auto text-vermillion-2 text-[11px]">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-border py-1">
                    <button className="flex items-center gap-2.5 w-full px-3 py-2 text-[12.5px] text-ink-3 hover:bg-cream-2 hover:text-ink transition-colors">
                      <Plus className="w-3.5 h-3.5 text-ink-4" />
                      <span>New project</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
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
          aria-label="Notifications"
        >
          <Bell className="w-4 h-4" />
        </button>

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => !userLoading && setUserMenuOpen(!userMenuOpen)}
            className={`w-[30px] h-[30px] rounded-full font-mono text-[11px] font-medium inline-flex items-center justify-center transition-opacity ${
              userLoading ? "bg-cream-3 animate-pulse" : "bg-vermillion-2 text-cream"
            } ${userMenuOpen ? "opacity-80" : "hover:opacity-90"}`}
            aria-label="User menu"
            aria-expanded={userMenuOpen}
          >
            {userLoading ? "" : userInitials}
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
                  href="https://docs.getkoji.dev"
                  external
                />
                <UserMenuItem
                  icon={<ExternalLink className="w-3.5 h-3.5" />}
                  label="API reference"
                  href="https://docs.getkoji.dev/reference/api"
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
