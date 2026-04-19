"use client";

import { useSidebar } from "@/lib/sidebar-context";
import { Sidebar } from "./Sidebar";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

export function SidebarShell({
  tenantSlug,
  children,
}: {
  tenantSlug: string;
  children: React.ReactNode;
}) {
  const { collapsed, toggle } = useSidebar();

  return (
    <div
      className="grid min-h-[calc(100vh-60px)] transition-[grid-template-columns] duration-200 ease-out"
      style={{ gridTemplateColumns: collapsed ? "48px 1fr" : "256px 1fr" }}
    >
      {/* Sidebar */}
      <div className="relative">
        {collapsed ? (
          /* Collapsed — just the toggle button */
          <aside className="border-r border-border bg-cream sticky top-[60px] h-[calc(100vh-60px)] flex flex-col items-center pt-3">
            <button
              onClick={toggle}
              className="p-2 rounded-sm text-ink-4 hover:text-ink hover:bg-cream-2 transition-colors"
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          </aside>
        ) : (
          /* Expanded — full sidebar with collapse button */
          <div className="relative">
            <Sidebar tenantSlug={tenantSlug} />
            <button
              onClick={toggle}
              className="absolute top-3 right-2 p-1.5 rounded-sm text-ink-4 hover:text-ink hover:bg-cream-2 transition-colors z-10"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <main className="min-w-0">{children}</main>
    </div>
  );
}
