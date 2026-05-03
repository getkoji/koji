"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSettingsExtensions } from "./SettingsExtensions";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { on, emit } from "@/lib/events";
import {
  Collapsible,
  CollapsibleContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@koji/ui";
import {
  LayoutDashboard,
  Workflow,
  Play,
  MessageSquare,
  ArrowDownToLine,
  ArrowLeftRight,
  ClipboardList,
  FileCode,
  ShieldCheck,
  Database,
  Settings,
  Key,
  Radio,
  Webhook,
  Users,
  Info,
  ChevronsUpDown,
  BarChart3,
} from "lucide-react";

interface NavItemLinkProps {
  href: string;
  icon: ReactNode;
  label: string;
  exact?: boolean;
}

/**
 * Base nav row with vermillion left-bar active indicator layered on top of
 * shadcn's SidebarMenuButton. The bar hides in icon-collapsed mode.
 */
function NavItemLink({ href, icon, label, exact }: NavItemLinkProps) {
  const pathname = usePathname();
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(href + "/");

  return (
    <SidebarMenuItem>
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-vermillion-2 rounded-r-sm z-10 group-data-[collapsible=icon]:hidden"
        />
      )}
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link href={href}>
          <span
            className={`flex items-center justify-center ${active ? "text-vermillion-2" : "text-ink-4"}`}
          >
            {icon}
          </span>
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SubNavItemLink({ href, icon, label }: NavItemLinkProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <Link href={href}>
          <span
            className={`flex items-center justify-center ${active ? "text-vermillion-2" : "text-ink-4"}`}
          >
            {icon}
          </span>
          <span>{label}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

const ICON = "w-[15px] h-[15px]";
const SUBICON = "w-[13px] h-[13px]";

/**
 * Returns the stored slug if it's still present in the tenant's schema list,
 * otherwise null. Used to drop stale localStorage entries for schemas that
 * have been deleted or renamed.
 */
export function reconcileStoredSchemaSlug(
  storedSlug: string | null,
  validSlugs: string[],
): string | null {
  if (!storedSlug) return null;
  return validSlugs.includes(storedSlug) ? storedSlug : null;
}

export function AppSidebar({
  tenantSlug: tenantSlugProp,
  schemaSlug,
}: {
  tenantSlug: string;
  schemaSlug?: string;
}) {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? tenantSlugProp;
  const base = `/t/${tenantSlug}`;
  const { hasPermission } = useAuth();
  const settingsExtensions = useSettingsExtensions();
  const router = useRouter();

  const projectSlug = pathname.match(/\/projects\/([^/]+)/)?.[1] ?? tenantSlug;
  const projectSettingsBase = `${base}/projects/${projectSlug}/settings`;
  const inProjectSettings = pathname.startsWith(projectSettingsBase);

  // Project list for the project switcher
  const { data: projectList, refetch: refetchProjects } = useApi(
    useCallback(
      () =>
        api
          .get<{ data: Array<{ slug: string; displayName: string }> }>("/api/projects")
          .then((r) => r.data),
      [],
    ),
  );
  useEffect(() => on("projects:updated", refetchProjects), [refetchProjects]);
  const currentProject = projectList?.find((p) => p.slug === projectSlug);
  const currentProjectName = currentProject?.displayName ?? projectSlug;

  const inOrgSettings = pathname.startsWith(`${base}/settings`);
  const isAdmin = hasPermission("tenant:admin");

  const [showCreateSchema, setShowCreateSchema] = useState(false);
  const schemaSubPage =
    pathname.match(/\/schemas\/[^/]+\/([^/]+)/)?.[1] ?? "build";

  const { data: schemasList, loading: schemasLoading, refetch: refetchSchemas } =
    useApi(
      useCallback(
        () =>
          api
            .get<{ data: Array<{ slug: string; displayName: string }> }>(
              "/api/schemas",
            )
            .then((r) => r.data),
        [],
      ),
    );

  useEffect(() => on("schemas:updated", refetchSchemas), [refetchSchemas]);

  const storageKey = `koji:schema:${tenantSlug}`;
  const urlSchemaSlug =
    schemaSlug ?? pathname.match(/\/schemas\/([^/]+)/)?.[1];
  const [storedSchemaSlug, setStoredSchemaSlug] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(storageKey);
  });

  useEffect(() => {
    if (urlSchemaSlug && typeof window !== "undefined") {
      localStorage.setItem(storageKey, urlSchemaSlug);
      setStoredSchemaSlug(urlSchemaSlug);
    }
  }, [urlSchemaSlug, storageKey]);

  useEffect(() => {
    if (!schemasList || typeof window === "undefined") return;

    const validSlugs = schemasList.map((s) => s.slug);
    const reconciled = reconcileStoredSchemaSlug(storedSchemaSlug, validSlugs);

    if (reconciled !== storedSchemaSlug) {
      if (reconciled === null) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, reconciled);
      }
      setStoredSchemaSlug(reconciled);
      return;
    }

    // Cold start: no stored slug, but we have schemas — pick the first.
    if (!storedSchemaSlug && schemasList.length > 0) {
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
    router.push(`${base}/schemas/${slug}/${schemaSubPage}`);
  }

  return (
    <Sidebar collapsible="icon" className="border-r border-border bg-cream">
      <SidebarContent className="gap-5 pt-4">
        {/* Project */}
        <SidebarGroup>
          <SidebarGroupLabel className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 flex items-center justify-between">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 hover:text-ink transition-colors text-left">
                  <span className="truncate max-w-[120px]">{currentProjectName}</span>
                  <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-50" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[200px]">
                {projectList?.map((p) => (
                  <DropdownMenuItem
                    key={p.slug}
                    onClick={() => router.push(`${base}/projects/${p.slug}`)}
                    className={p.slug === projectSlug ? "bg-cream-2 font-medium" : ""}
                  >
                    <span className="truncate">{p.displayName}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push("/new-project")}>
                  + New project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItemLink
                href={`${base}/projects/${projectSlug}`}
                icon={<LayoutDashboard className={ICON} />}
                label="Overview"
                exact
              />
              <NavItemLink
                href={`${base}/pipelines`}
                icon={<Workflow className={ICON} />}
                label="Pipelines"
              />
              <NavItemLink
                href={`${base}/jobs`}
                icon={<Play className={ICON} />}
                label="Jobs"
              />
              <NavItemLink
                href={`${base}/review`}
                icon={<MessageSquare className={ICON} />}
                label="Review"
              />
              <NavItemLink
                href={`${base}/sources`}
                icon={<ArrowDownToLine className={ICON} />}
                label="Sources"
              />

              {/* Project settings — expands with sub-items when on a settings route */}
              <Collapsible asChild open={inProjectSettings}>
                <SidebarMenuItem>
                  {inProjectSettings && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-[14px] -translate-y-1/2 w-[3px] h-4 bg-vermillion-2 rounded-r-sm z-10 group-data-[collapsible=icon]:hidden"
                    />
                  )}
                  <SidebarMenuButton
                    asChild
                    isActive={inProjectSettings}
                    tooltip="Settings"
                  >
                    <Link href={`${projectSettingsBase}/general`}>
                      <span
                        className={`flex items-center justify-center ${
                          inProjectSettings ? "text-vermillion-2" : "text-ink-4"
                        }`}
                      >
                        <Settings className={ICON} />
                      </span>
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SubNavItemLink
                        href={`${projectSettingsBase}/general`}
                        icon={<Info className={SUBICON} />}
                        label="General"
                      />
                      <SubNavItemLink
                        href={`${projectSettingsBase}/api-keys`}
                        icon={<Key className={SUBICON} />}
                        label="API Keys"
                      />
                      <SubNavItemLink
                        href={`${projectSettingsBase}/model-providers`}
                        icon={<Radio className={SUBICON} />}
                        label="Model Endpoints"
                      />
                      <SubNavItemLink
                        href={`${projectSettingsBase}/webhooks`}
                        icon={<Webhook className={SUBICON} />}
                        label="Webhooks"
                      />
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Schema */}
        <SidebarGroup className="group-data-[collapsible=icon]:pt-0">
          {schemasLoading ? (
            <>
              <SidebarGroupLabel className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4">
                Schema
              </SidebarGroupLabel>
              <SidebarGroupContent className="px-2 group-data-[collapsible=icon]:hidden">
                <div className="space-y-2 mt-1">
                  <div className="h-[30px] bg-cream-2 rounded-sm animate-pulse" />
                  <div className="h-[30px] bg-cream-2 rounded-sm animate-pulse w-3/4" />
                  <div className="h-[30px] bg-cream-2 rounded-sm animate-pulse w-1/2" />
                </div>
              </SidebarGroupContent>
            </>
          ) : (schemasList ?? []).length === 0 ? (
            <>
              <SidebarGroupLabel className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4">
                Schema
              </SidebarGroupLabel>
              <SidebarGroupContent className="px-2 group-data-[collapsible=icon]:hidden">
                <div className="border border-border rounded-sm p-3 text-center mt-1">
                  <div className="text-[12px] text-ink-3 mb-2">
                    No schemas yet
                  </div>
                  <button
                    onClick={() => setShowCreateSchema(true)}
                    className="inline-flex items-center gap-1 text-[12px] text-vermillion-2 hover:text-ink transition-colors font-medium"
                  >
                    <span className="text-[14px] leading-none">+</span> Create
                    your first
                  </button>
                </div>
              </SidebarGroupContent>
            </>
          ) : (
            <>
              {/* Icon-mode: thin separator above the schema sub-nav icons */}
              <div
                aria-hidden
                className="hidden group-data-[collapsible=icon]:block w-5 border-t border-border mx-auto mb-1"
              />

              {/* Expanded-mode: schema picker. The DropdownMenu sits in a plain
                  wrapper rather than SidebarGroupLabel+asChild because Slot
                  can't merge props onto the DropdownMenu provider. */}
              <div className="px-2 mb-1 group-data-[collapsible=icon]:hidden">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 px-2 py-1.5 rounded-sm flex items-center gap-1.5 hover:bg-cream-2 hover:text-ink-2 transition-colors w-full text-left group/schema"
                    >
                      <span>Schema</span>
                      {currentSchemaSlug && (
                        <>
                          <span className="text-cream-4 font-normal">·</span>
                          <span className="normal-case italic text-ink-3 group-hover/schema:text-ink tracking-[0.02em] text-[10.5px] transition-colors truncate">
                            {currentSchemaSlug}
                          </span>
                        </>
                      )}
                      <ChevronsUpDown className="w-3 h-3 ml-auto text-ink-4 group-hover/schema:text-ink-3 transition-colors shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-52 bg-white border border-border rounded-sm shadow-md"
                  >
                    <div className="px-2 py-1.5 font-mono text-[9.5px] font-medium tracking-[0.1em] uppercase text-ink-4">
                      Schemas
                    </div>
                    <DropdownMenuSeparator />
                    {(schemasList ?? []).map((s) => (
                      <DropdownMenuItem
                        key={s.slug}
                        onSelect={() => selectSchema(s.slug)}
                        className={`text-[12.5px] ${
                          s.slug === currentSchemaSlug
                            ? "text-ink font-medium"
                            : "text-ink-3"
                        }`}
                      >
                        <span className="flex-1">{s.displayName}</span>
                        {s.slug === currentSchemaSlug && (
                          <span className="text-vermillion-2 text-[11px]">✓</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setShowCreateSchema(true)}
                      className="text-[12px] text-ink-3"
                    >
                      <span className="text-[14px] leading-none">+</span> New
                      schema
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <SidebarGroupContent>
                <SidebarMenu>
                  {currentSchemaSlug && (
                    <>
                      <NavItemLink
                        href={`${base}/schemas/${currentSchemaSlug}/build`}
                        icon={<FileCode className={ICON} />}
                        label="Build"
                      />
                      <NavItemLink
                        href={`${base}/schemas/${currentSchemaSlug}/validate`}
                        icon={<ShieldCheck className={ICON} />}
                        label="Validate"
                      />
                      <NavItemLink
                        href={`${base}/schemas/${currentSchemaSlug}/corpus`}
                        icon={<Database className={ICON} />}
                        label="Corpus"
                      />
                      <NavItemLink
                        href={`${base}/schemas/${currentSchemaSlug}/forms`}
                        icon={<ClipboardList className={ICON} />}
                        label="Forms"
                      />
                      <NavItemLink
                        href={`${base}/schemas/${currentSchemaSlug}/compare`}
                        icon={<ArrowLeftRight className={ICON} />}
                        label="Compare"
                      />
                      <NavItemLink
                        href={`${base}/schemas/${currentSchemaSlug}/performance`}
                        icon={<BarChart3 className={ICON} />}
                        label="Performance"
                      />
                    </>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </>
          )}
        </SidebarGroup>
      </SidebarContent>

      {/* Organization — admin-only */}
      {isAdmin && (
        <SidebarFooter className="border-t border-border">
          <SidebarMenu>
            <Collapsible asChild open={inOrgSettings}>
              <SidebarMenuItem>
                {inOrgSettings && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-[14px] -translate-y-1/2 w-[3px] h-4 bg-vermillion-2 rounded-r-sm z-10 group-data-[collapsible=icon]:hidden"
                  />
                )}
                <SidebarMenuButton
                  asChild
                  isActive={inOrgSettings}
                  tooltip="Organization"
                >
                  <Link href={settingsExtensions.hideDefaultNav && settingsExtensions.navItems[0] ? `${base}${settingsExtensions.navItems[0].href}` : `${base}/settings/general`}>
                    <span
                      className={`flex items-center justify-center ${
                        inOrgSettings ? "text-vermillion-2" : "text-ink-4"
                      }`}
                    >
                      <Settings className={ICON} />
                    </span>
                    <span>Organization</span>
                  </Link>
                </SidebarMenuButton>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {!settingsExtensions.hideDefaultNav && (
                      <>
                        <SubNavItemLink
                          href={`${base}/settings/general`}
                          icon={<Info className={SUBICON} />}
                          label="General"
                        />
                        <SubNavItemLink
                          href={`${base}/settings/members`}
                          icon={<Users className={SUBICON} />}
                          label="Members"
                        />
                      </>
                    )}
                    {settingsExtensions.navItems.map((item) => (
                      <SubNavItemLink
                        key={item.href}
                        href={`${base}${item.href}`}
                        icon={item.icon}
                        label={item.label}
                      />
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          </SidebarMenu>
        </SidebarFooter>
      )}

      <SidebarRail />

      {/* Create schema dialog — rendered via portal to escape sidebar overflow */}
      {showCreateSchema &&
        typeof document !== "undefined" &&
        createPortal(
          <CreateSchemaDialog
            onClose={() => setShowCreateSchema(false)}
            onCreated={(slug) => {
              setShowCreateSchema(false);
              router.push(`${base}/schemas/${slug}/build`);
            }}
          />,
          document.body,
        )}
    </Sidebar>
  );
}

function CreateSchemaDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!slugTouched && name) {
    const auto = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .replace(/-+/g, "_");
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
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Insurance Claim"
              autoFocus
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Slug</label>
            <input
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
              }}
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
            <p className="text-[11px] text-ink-4">
              Used in the URL and API. Lowercase, underscores.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">
              Description{" "}
              <span className="text-ink-4 font-normal">(optional)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this schema extract?"
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
              {error}
            </div>
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
              disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create schema"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
