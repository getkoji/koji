"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { Bell, User, Settings, LogOut, HelpCircle, ExternalLink, ChevronsUpDown, Plus } from "lucide-react";
import { SidebarTrigger } from "@koji/ui";
import { KojiLogo } from "./KojiLogo";
import { CommandPalette } from "./CommandPalette";
import { me as meApi, projectsApi, notificationsApi, getSignOutHandler, type ProjectRow, type NotificationRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { on } from "@/lib/events";

export function TopBar({ tenantSlug: tenantSlugProp }: { tenantSlug?: string }) {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? tenantSlugProp;
  const router = useRouter();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const { data: user, loading: userLoading } = useApi(useCallback(() => meApi.get(), []));
  const { data: projectList, loading: projectsLoading, refetch: refetchProjects } = useApi(useCallback(() => projectsApi.list(), []));

  // Refetch when a project is updated elsewhere
  useEffect(() => on("projects:updated", refetchProjects), [refetchProjects]);

  // Global ⌘K / Ctrl+K shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdkOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const userName = user?.name ?? "User";
  const userEmail = user?.email ?? "";
  const userInitials = userName.split(" ").map(n => n[0]).join("").toUpperCase() || "?";

  // Notification count polling (every 30s)
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifItems, setNotifItems] = useState<NotificationRow[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = () => notificationsApi.count().then((n) => alive && setUnreadCount(n)).catch(() => {});
    poll();
    const h = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(h); };
  }, []);
  // Fetch items when dropdown opens
  useEffect(() => {
    if (!notifOpen) return;
    notificationsApi.list({ limit: 10 }).then(setNotifItems).catch(() => {});
  }, [notifOpen]);

  // Close dropdowns on click outside or escape
  useEffect(() => {
    if (!userMenuOpen && !projectMenuOpen && !notifOpen) return;
    function handleClick(e: MouseEvent) {
      if (userMenuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (projectMenuOpen && projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
      if (notifOpen && notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setUserMenuOpen(false);
        setProjectMenuOpen(false);
        setNotifOpen(false);
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
    <header className="flex items-center gap-4 h-[60px] px-5 bg-cream border-b border-border sticky top-0 z-30">
      {/* Brand + project switcher */}
      <div className="flex items-center gap-2.5 shrink-0">
        <SidebarTrigger className="-ml-2 text-ink-3 hover:text-ink hover:bg-cream-2" />
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
                    <button
                      onClick={() => {
                        setProjectMenuOpen(false);
                        router.push("/new-project");
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-[12.5px] text-ink-3 hover:bg-cream-2 hover:text-ink transition-colors"
                    >
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

      {/* Universal trace bar — opens command palette */}
      <button
        type="button"
        onClick={() => setCmdkOpen(true)}
        className="mx-auto w-full max-w-[520px] flex items-center gap-2 px-3.5 py-2 bg-cream-2 border border-border rounded-sm hover:border-vermillion-2 hover:bg-cream transition-colors cursor-pointer"
      >
        <span className="font-mono text-vermillion-2 text-[13px] font-semibold">↳</span>
        <span className="flex-1 text-left font-mono text-xs text-ink-4">
          Search schemas, pipelines, jobs…
        </span>
        <kbd className="font-mono text-[10px] text-ink-4 px-1.5 py-0.5 border border-border rounded-sm bg-cream">
          ⌘K
        </kbd>
      </button>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />

      {/* Right side */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => setNotifOpen(!notifOpen)}
            className="w-8 h-8 inline-flex items-center justify-center rounded-sm text-ink-3 hover:bg-cream-2 hover:text-ink transition-colors relative"
            aria-label="Notifications"
            aria-expanded={notifOpen}
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute top-0.5 right-0.5 w-[14px] h-[14px] rounded-full bg-vermillion-2 text-cream text-[8px] font-mono font-bold flex items-center justify-center leading-none">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>
          {notifOpen && (
            <div className="absolute right-0 top-[38px] w-[320px] bg-white border border-border-strong rounded-sm shadow-lg overflow-hidden z-50">
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
                <span className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4">
                  Notifications
                </span>
                {unreadCount > 0 && (
                  <button
                    onClick={() => {
                      notificationsApi.markAllRead().then(() => {
                        setUnreadCount(0);
                        setNotifItems((prev) => prev.map((n) => ({ ...n, readAt: new Date().toISOString() })));
                      });
                    }}
                    className="font-mono text-[10px] text-vermillion-2 hover:underline"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {notifItems.length === 0 ? (
                  <div className="px-3.5 py-6 text-center text-[12px] text-ink-4">
                    No notifications yet
                  </div>
                ) : (
                  notifItems.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => {
                        if (!n.readAt) {
                          notificationsApi.markRead(n.id).then(() => {
                            setUnreadCount((c) => Math.max(0, c - 1));
                            setNotifItems((prev) =>
                              prev.map((item) =>
                                item.id === n.id ? { ...item, readAt: new Date().toISOString() } : item,
                              ),
                            );
                          });
                        }
                      }}
                      className={`w-full text-left px-3.5 py-2.5 border-b border-dotted border-border last:border-b-0 hover:bg-cream-2/60 transition-colors ${
                        n.readAt ? "opacity-60" : ""
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {!n.readAt && (
                          <span className="w-1.5 h-1.5 rounded-full bg-vermillion-2 mt-1.5 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium text-ink truncate">{n.title}</div>
                          {n.body && (
                            <div className="text-[11px] text-ink-3 mt-0.5 line-clamp-2">{n.body}</div>
                          )}
                          <div className="font-mono text-[9px] text-ink-4 mt-1">
                            {formatNotifTime(n.createdAt)}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

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
                  onClick={async () => {
                    const customSignOut = getSignOutHandler();
                    if (customSignOut) {
                      await customSignOut();
                      return;
                    }
                    try {
                      await fetch(`/api/auth/session`, {
                        method: "DELETE",
                        credentials: "include",
                      });
                    } catch {}
                    window.location.href = "/login";
                  }}
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

function formatNotifTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString();
}
