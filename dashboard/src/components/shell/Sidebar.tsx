"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSettingsExtensions } from "./SettingsExtensions";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { on, emit } from "@/lib/events";
import {
  LayoutDashboard,
  Workflow,
  Play,
  MessageSquare,
  ArrowDownToLine,
  FileCode,
  ShieldCheck,
  Database,
  Target,
  Settings,
  Sparkles,
  Key,
  Radio,
  Webhook,
  Users,
  Info,
  BookOpen,
  ChevronsUpDown,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

interface NavItemProps {
  href: string;
  icon: ReactNode;
  label: string;
  count?: number;
  exact?: boolean;
}

function NavItem({ href, icon, label, count, exact, collapsed }: NavItemProps & { collapsed?: boolean }) {
  const pathname = usePathname();
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={`flex items-center rounded-sm text-[13.5px] relative transition-colors ${
        collapsed ? "justify-center w-10 h-10 mx-auto p-0" : "gap-2.5 px-2.5 py-[7px]"
      } ${
        active
          ? "bg-cream-2 text-ink font-medium"
          : "text-ink-2 hover:bg-cream-2 hover:text-ink"
      }`}
    >
      <span
        className={`w-4 shrink-0 flex items-center justify-center ${
          active ? "text-vermillion-2" : "text-ink-4"
        }`}
      >
        {icon}
      </span>
      <span className={`transition-all duration-300 overflow-hidden whitespace-nowrap ${collapsed ? "w-0 opacity-0" : "w-auto opacity-100"}`}>
        {label}
      </span>
      {count !== undefined && !collapsed && (
        <span className="ml-auto font-mono text-[11px] text-ink-4">{count}</span>
      )}
      {active && !collapsed && (
        <span className="absolute left-[-13px] top-1/2 -translate-y-1/2 w-[3px] h-4 bg-vermillion-2 rounded-r-sm" />
      )}
    </Link>
  );
}

const ICON_SIZE = "w-[15px] h-[15px]";

export function Sidebar({ tenantSlug: tenantSlugProp, schemaSlug, collapsed, onCollapse }: { tenantSlug: string; schemaSlug?: string; collapsed?: boolean; onCollapse?: () => void }) {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? tenantSlugProp;
  const base = `/t/${tenantSlug}`;
  const { hasPermission } = useAuth();
  const settingsExtensions = useSettingsExtensions();

  // Derive current project slug from URL if on a project settings page
  // For now, use the tenant slug as the default project (setup creates project with same slug)
  const projectSlug = pathname.match(/\/projects\/([^/]+)/)?.[1] ?? tenantSlug;
  const projectSettingsBase = `${base}/projects/${projectSlug}/settings`;
  const inProjectSettings = pathname.startsWith(projectSettingsBase);

  const isAdmin = hasPermission("tenant:admin");

  // Schema picker — persists selection in localStorage
  const router = useRouter();
  const [schemaPickerOpen, setSchemaPickerOpen] = useState(false);
  const [showCreateSchema, setShowCreateSchema] = useState(false);
  const schemaPickerRef = useRef<HTMLDivElement>(null);
  const schemaSubPage = pathname.match(/\/schemas\/[^/]+\/([^/]+)/)?.[1] ?? "build";

  const { data: schemasList, loading: schemasLoading, refetch: refetchSchemas } = useApi(
    useCallback(() => api.get<{ data: Array<{ slug: string; displayName: string }> }>("/api/schemas").then((r) => r.data), []),
  );

  useEffect(() => on("schemas:updated", refetchSchemas), [refetchSchemas]);

  // Resolve current schema: URL > localStorage > first in list
  const storageKey = `koji:schema:${tenantSlug}`;
  const urlSchemaSlug = schemaSlug ?? pathname.match(/\/schemas\/([^/]+)/)?.[1];
  const [storedSchemaSlug, setStoredSchemaSlug] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(storageKey);
  });

  // If URL has a schema, persist it
  useEffect(() => {
    if (urlSchemaSlug && typeof window !== "undefined") {
      localStorage.setItem(storageKey, urlSchemaSlug);
      setStoredSchemaSlug(urlSchemaSlug);
    }
  }, [urlSchemaSlug, storageKey]);

  // Auto-select first schema if nothing is stored and schemas exist
  useEffect(() => {
    if (!storedSchemaSlug && schemasList && schemasList.length > 0 && typeof window !== "undefined") {
      const first = schemasList[0]!.slug;
      localStorage.setItem(storageKey, first);
      setStoredSchemaSlug(first);
    }
  }, [storedSchemaSlug, schemasList, storageKey]);

  const currentSchemaSlug = urlSchemaSlug ?? storedSchemaSlug;

  function selectSchema(slug: string) {
    if (typeof window !== "undefined") {
      localStorage.setItem(storageKey, slug);
    }
    setStoredSchemaSlug(slug);
    setSchemaPickerOpen(false);
    router.push(`${base}/schemas/${slug}/${schemaSubPage}`);
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (schemaPickerRef.current && !schemaPickerRef.current.contains(e.target as Node)) {
        setSchemaPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const inOrgSettings = pathname.startsWith(`${base}/settings`);
  const c = collapsed;

  return (
    <aside className={`border-r border-border bg-cream flex flex-col gap-5 sticky top-[60px] h-[calc(100vh-60px)] overflow-y-auto overflow-x-hidden shrink-0 transition-all duration-300 ${c ? "w-[48px] px-0 pt-3 pb-4" : "w-[256px] px-3.5 pt-5 pb-8"}`}>
      {/* Project section */}
      <nav className="flex flex-col gap-0.5">
        <div className={`font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 pb-2 flex items-center transition-all duration-300 ${c ? "justify-center px-0 h-10" : "justify-between px-2.5"}`}>
          {!c && <span>Project</span>}
          {onCollapse && (
            <button onClick={onCollapse} className={`text-ink-4 hover:text-ink transition-colors rounded-sm hover:bg-cream-2 flex items-center justify-center ${c ? "w-10 h-10 mx-auto" : "p-1"}`} aria-label={c ? "Expand sidebar" : "Collapse sidebar"}>
              {c ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
        <NavItem href={base} icon={<LayoutDashboard className={ICON_SIZE} />} label="Overview" exact collapsed={c} />
        <NavItem href={`${base}/pipelines`} icon={<Workflow className={ICON_SIZE} />} label="Pipelines" collapsed={c} />
        <NavItem href={`${base}/jobs`} icon={<Play className={ICON_SIZE} />} label="Jobs" collapsed={c} />
        <NavItem href={`${base}/review`} icon={<MessageSquare className={ICON_SIZE} />} label="Review" collapsed={c} />
        <NavItem href={`${base}/sources`} icon={<ArrowDownToLine className={ICON_SIZE} />} label="Sources" collapsed={c} />

        {/* Project settings — expands when active */}
        <NavItem
          href={projectSettingsBase}
          icon={<Settings className={ICON_SIZE} />}
          label="Settings"
          exact={!inProjectSettings}
          collapsed={c}
        />
        {!c && (
        <div
          className="ml-4 pl-2 border-l border-border flex flex-col gap-0.5 overflow-hidden transition-all duration-200 ease-out"
          style={{
            maxHeight: inProjectSettings ? "200px" : "0px",
            opacity: inProjectSettings ? 1 : 0,
            marginTop: inProjectSettings ? "2px" : "0px",
          }}
        >
          <NavItem href={`${projectSettingsBase}/general`} icon={<Info className={ICON_SIZE} />} label="General" />
          <NavItem href={`${projectSettingsBase}/api-keys`} icon={<Key className={ICON_SIZE} />} label="API Keys" />
          <NavItem href={`${projectSettingsBase}/model-providers`} icon={<Radio className={ICON_SIZE} />} label="Model Providers" />
          <NavItem href={`${projectSettingsBase}/webhooks`} icon={<Webhook className={ICON_SIZE} />} label="Webhooks" />
        </div>
        )}
      </nav>

      {/* Schema section */}
      <nav className="flex flex-col gap-0.5">
        {c ? (
          currentSchemaSlug ? (
            <>
              <div className="w-6 border-t border-border my-1 mx-auto" />
              <NavItem href={`${base}/schemas/${currentSchemaSlug}/build`} icon={<FileCode className={ICON_SIZE} />} label="Build" collapsed />
              <NavItem href={`${base}/schemas/${currentSchemaSlug}/validate`} icon={<ShieldCheck className={ICON_SIZE} />} label="Validate" collapsed />
              <NavItem href={`${base}/schemas/${currentSchemaSlug}/corpus`} icon={<Database className={ICON_SIZE} />} label="Corpus" collapsed />
            </>
          ) : null
        ) : schemasLoading ? (
          /* Loading skeleton */
          <>
            <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 px-2.5 pb-2">
              Schema
            </div>
            <div className="mx-2.5 space-y-2">
              <div className="h-[30px] bg-cream-2 rounded-sm animate-pulse" />
              <div className="h-[30px] bg-cream-2 rounded-sm animate-pulse w-3/4" />
              <div className="h-[30px] bg-cream-2 rounded-sm animate-pulse w-1/2" />
            </div>
          </>
        ) : (schemasList ?? []).length === 0 ? (
          /* Empty state — no schemas exist */
          <>
            <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 px-2.5 pb-2">
              Schema
            </div>
            <div className="mx-2.5 border border-border rounded-sm p-3 text-center">
              <div className="text-[12px] text-ink-3 mb-2">No schemas yet</div>
              <button
                onClick={() => setShowCreateSchema(true)}
                className="inline-flex items-center gap-1 text-[12px] text-vermillion-2 hover:text-ink transition-colors font-medium"
              >
                <span className="text-[14px] leading-none">+</span> Create your first
              </button>
            </div>
          </>
        ) : (
          /* Schemas exist — show picker + nav */
          <>
            <div className="relative" ref={schemaPickerRef}>
              <button
                onClick={() => setSchemaPickerOpen(!schemaPickerOpen)}
                className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 px-2.5 py-1.5 mb-1 -mx-0.5 rounded-sm flex items-center gap-1.5 hover:bg-cream-2 hover:text-ink-2 transition-colors w-[calc(100%+4px)] text-left group"
              >
                <span>Schema</span>
                {currentSchemaSlug && (
                  <>
                    <span className="text-cream-4 font-normal">·</span>
                    <span className="normal-case italic text-ink-3 group-hover:text-ink tracking-[0.02em] text-[10.5px] transition-colors">
                      {currentSchemaSlug}
                    </span>
                  </>
                )}
                <ChevronsUpDown className="w-3 h-3 ml-auto text-ink-4 group-hover:text-ink-3 transition-colors shrink-0" />
              </button>

              {schemaPickerOpen && (
                <div className="absolute left-2 top-full mt-1 w-52 bg-white border border-border rounded-sm shadow-md z-20 overflow-hidden">
                  <div className="px-3 py-2 border-b border-border font-mono text-[9.5px] font-medium tracking-[0.1em] uppercase text-ink-4">
                    Schemas
                  </div>
                  <div className="max-h-[200px] overflow-y-auto">
                    {(schemasList ?? []).map((s) => (
                      <button
                        key={s.slug}
                        onClick={() => selectSchema(s.slug)}
                        className={`w-full text-left px-3 py-2 text-[12.5px] hover:bg-cream-2 transition-colors flex items-center justify-between ${
                          s.slug === currentSchemaSlug ? "text-ink font-medium" : "text-ink-3"
                        }`}
                      >
                        <span>{s.displayName}</span>
                        {s.slug === currentSchemaSlug && <span className="text-vermillion-2 text-[11px]">✓</span>}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-border">
                    <button
                      onClick={() => { setSchemaPickerOpen(false); setShowCreateSchema(true); }}
                      className="w-full text-left px-3 py-2 text-[12px] text-ink-3 hover:text-ink hover:bg-cream-2 transition-colors flex items-center gap-1.5"
                    >
                      <span className="text-[14px] leading-none">+</span> New schema
                    </button>
                  </div>
                </div>
              )}
            </div>

            {currentSchemaSlug && (
              <>
                <NavItem href={`${base}/schemas/${currentSchemaSlug}/build`} icon={<FileCode className={ICON_SIZE} />} label="Build" collapsed={c} />
                <NavItem href={`${base}/schemas/${currentSchemaSlug}/validate`} icon={<ShieldCheck className={ICON_SIZE} />} label="Validate" collapsed={c} />
                <NavItem href={`${base}/schemas/${currentSchemaSlug}/corpus`} icon={<Database className={ICON_SIZE} />} label="Corpus" collapsed={c} />
              </>
            )}
          </>
        )}
      </nav>

      {/* Create schema dialog — rendered via portal to escape sidebar overflow */}
      {showCreateSchema && typeof document !== "undefined" && createPortal(
        <CreateSchemaDialog
          onClose={() => setShowCreateSchema(false)}
          onCreated={(slug) => {
            setShowCreateSchema(false);
            router.push(`${base}/schemas/${slug}/build`);
          }}
        />,
        document.body,
      )}

      {/* Organization settings — admin+ only */}
      {isAdmin && (() => {
        return (
          <div className={`mt-auto pt-4 border-t border-border flex flex-col gap-0.5 ${c ? "items-center" : ""}`}>
            <NavItem
              href={`${base}/settings`}
              icon={<Settings className={ICON_SIZE} />}
              label="Organization"
              exact={!inOrgSettings}
              collapsed={c}
            />
            {!c && (
            <div
              className="ml-4 pl-2 border-l border-border flex flex-col gap-0.5 overflow-hidden transition-all duration-200 ease-out"
              style={{
                maxHeight: inOrgSettings ? "200px" : "0px",
                opacity: inOrgSettings ? 1 : 0,
                marginTop: inOrgSettings ? "2px" : "0px",
              }}
            >
              <NavItem href={`${base}/settings/general`} icon={<Info className={ICON_SIZE} />} label="General" />
              <NavItem href={`${base}/settings/members`} icon={<Users className={ICON_SIZE} />} label="Members" />
              <NavItem href={`${base}/settings/model-catalog`} icon={<BookOpen className={ICON_SIZE} />} label="Model Catalog" />
              {settingsExtensions.navItems.map((item) => (
                <NavItem key={item.href} href={`${base}${item.href}`} icon={item.icon} label={item.label} />
              ))}
            </div>
            )}
          </div>
        );
      })()}
    </aside>
  );
}

function CreateSchemaDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-slug
  if (!slugTouched && name) {
    const auto = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/-+/g, "_");
    if (auto !== slug) setSlug(auto);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await api.post("/api/schemas", {
        slug,
        display_name: name,
        description: description || undefined,
      });
      emit("schemas:updated");
      onCreated(slug);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create schema");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Create schema</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Define a new extraction schema. You'll edit the YAML in build mode.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Insurance Claim" autoFocus
              data-1p-ignore autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Slug</label>
            <input required value={slug}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")); }}
              data-1p-ignore autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            <p className="text-[11px] text-ink-4">Used in the URL and API. Lowercase, underscores.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Description <span className="text-ink-4 font-normal">(optional)</span></label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this schema extract?"
              data-1p-ignore autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {creating ? "Creating..." : "Create schema"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
