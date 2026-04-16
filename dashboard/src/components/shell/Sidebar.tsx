"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItemProps {
  href: string;
  glyph: string;
  label: string;
  count?: number;
}

function NavItem({ href, glyph, label, count }: NavItemProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");

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
        className={`font-mono text-[13px] w-4 text-center shrink-0 ${
          active ? "text-vermillion-2" : "text-ink-4"
        }`}
      >
        {glyph}
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

export function Sidebar({ tenantSlug, schemaSlug }: { tenantSlug: string; schemaSlug?: string }) {
  const base = `/t/${tenantSlug}`;

  return (
    <aside className="border-r border-border px-3.5 pt-5 pb-8 bg-cream flex flex-col gap-5 sticky top-[60px] h-[calc(100vh-60px)] overflow-y-auto w-[256px] shrink-0">
      {/* Playground button */}
      <Link
        href={`${base}/playground`}
        className="flex items-center gap-2 px-3 py-2.5 bg-ink text-cream rounded-sm text-[13px] font-medium hover:bg-vermillion-2 transition-colors"
      >
        <span className="font-mono text-vermillion-3 text-sm">✦</span>
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
        <NavItem href={base} glyph="◉" label="Overview" />
        <NavItem href={`${base}/pipelines`} glyph="→" label="Pipelines" count={5} />
        <NavItem href={`${base}/jobs`} glyph="◌" label="Jobs" count={238} />
        <NavItem href={`${base}/review`} glyph="◇" label="Review" count={8} />
        <NavItem href={`${base}/sources`} glyph="⇲" label="Sources" count={5} />
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
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/build`} glyph="≡" label="Build" />
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/validate`} glyph="▦" label="Validate" />
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/corpus`} glyph="▤" label="Corpus" count={38} />
        <NavItem href={`${base}/schemas/${schemaSlug ?? "invoice"}/benchmarks`} glyph="⊙" label="Benchmarks" />
      </nav>

      {/* Footer */}
      <div className="mt-auto pt-4 border-t border-border flex flex-col gap-0.5">
        <NavItem href={`${base}/settings`} glyph="◈" label="Settings" />
      </div>
    </aside>
  );
}
