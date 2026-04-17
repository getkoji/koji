"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
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
  Users,
  Key,
  Radio,
  Webhook,

} from "lucide-react";

interface NavItemProps {
  href: string;
  icon: ReactNode;
  label: string;
  count?: number;
  exact?: boolean;
}

function NavItem({ href, icon, label, count, exact }: NavItemProps) {
  const pathname = usePathname();
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 px-2.5 py-[7px] rounded-sm text-[13.5px] relative transition-colors ${
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
      <span>{label}</span>
      {count !== undefined && (
        <span className="ml-auto font-mono text-[11px] text-ink-4">{count}</span>
      )}
      {active && (
        <span className="absolute left-[-13px] top-1/2 -translate-y-1/2 w-[3px] h-4 bg-vermillion-2 rounded-r-sm" />
      )}
    </Link>
  );
}

const ICON_SIZE = "w-[15px] h-[15px]";

export function Sidebar({ tenantSlug: tenantSlugProp, schemaSlug }: { tenantSlug: string; schemaSlug?: string }) {
  const pathname = usePathname();
  // Derive tenant slug from the URL as the primary source, prop as fallback.
  // This avoids hydration mismatches when Next.js re-renders the client component
  // before the async server layout resolves params on client-side navigation.
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? tenantSlugProp;
  const base = `/t/${tenantSlug}`;
  const inSettings = pathname.startsWith(`${base}/settings`);

  return (
    <aside className="border-r border-border px-3.5 pt-5 pb-8 bg-cream flex flex-col gap-5 sticky top-[60px] h-[calc(100vh-60px)] overflow-y-auto w-[256px] shrink-0">
      {/* Playground button */}
      <Link
        href={`${base}/playground`}
        className="flex items-center gap-2 px-3 py-2.5 bg-ink text-cream rounded-sm text-[13px] font-medium hover:bg-vermillion-2 transition-colors"
      >
        <Sparkles className="w-3.5 h-3.5 text-vermillion-3" />
        <span>Playground</span>
        <span className="flex-1" />
        <kbd className="font-mono text-[10px] text-cream-3 px-1.5 py-0.5 border border-cream/15 rounded-sm">
          P
        </kbd>
      </Link>

      {/* Project section */}
      <nav className="flex flex-col gap-0.5">
        <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 px-2.5 pb-2">
          Project
        </div>
        <NavItem href={base} icon={<LayoutDashboard className={ICON_SIZE} />} label="Overview" exact />
        <NavItem href={`${base}/pipelines`} icon={<Workflow className={ICON_SIZE} />} label="Pipelines" count={5} />
        <NavItem href={`${base}/jobs`} icon={<Play className={ICON_SIZE} />} label="Jobs" count={238} />
        <NavItem href={`${base}/review`} icon={<MessageSquare className={ICON_SIZE} />} label="Review" count={8} />
        <NavItem href={`${base}/sources`} icon={<ArrowDownToLine className={ICON_SIZE} />} label="Sources" count={5} />
      </nav>

      {/* Schema section */}
      <nav className="flex flex-col gap-0.5">
        <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 px-2.5 pb-2 flex items-baseline gap-1.5">
          <span>Schema</span>
          <span className="text-cream-4 font-normal">·</span>
          <span className="normal-case italic text-ink-3 tracking-[0.02em] text-[10.5px]">
            {schemaSlug ?? "invoice"}
          </span>
          <span className="w-1 h-1 rounded-full bg-vermillion-2 shadow-[0_0_0_2px_rgba(153,39,24,0.14)] ml-0.5" />
        </div>
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/build`} icon={<FileCode className={ICON_SIZE} />} label="Build" />
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/validate`} icon={<ShieldCheck className={ICON_SIZE} />} label="Validate" />
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/corpus`} icon={<Database className={ICON_SIZE} />} label="Corpus" count={38} />
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/benchmarks`} icon={<Target className={ICON_SIZE} />} label="Benchmarks" />
      </nav>

      {/* Settings — expands to show sub-items when active */}
      <div className="mt-auto pt-4 border-t border-border flex flex-col gap-0.5">
        <NavItem href={`${base}/settings`} icon={<Settings className={ICON_SIZE} />} label="Settings" exact={!inSettings} />
        <div
          className="ml-4 pl-2 border-l border-border flex flex-col gap-0.5 overflow-hidden transition-all duration-200 ease-out"
          style={{
            maxHeight: inSettings ? "200px" : "0px",
            opacity: inSettings ? 1 : 0,
            marginTop: inSettings ? "2px" : "0px",
          }}
        >
          <NavItem href={`${base}/settings/members`} icon={<Users className={ICON_SIZE} />} label="Members" />
          <NavItem href={`${base}/settings/api-keys`} icon={<Key className={ICON_SIZE} />} label="API Keys" />
          <NavItem href={`${base}/settings/endpoints`} icon={<Radio className={ICON_SIZE} />} label="Endpoints" />
          <NavItem href={`${base}/settings/webhooks`} icon={<Webhook className={ICON_SIZE} />} label="Webhooks" />
        </div>
      </div>
    </aside>
  );
}
