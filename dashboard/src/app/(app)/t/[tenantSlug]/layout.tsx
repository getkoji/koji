"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { AuthProvider } from "@/lib/auth-context";

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("koji:sidebar:collapsed") === "true";
  });

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("koji:sidebar:collapsed", String(next));
      return next;
    });
  }

  if (!tenantSlug || tenantSlug === "undefined") return null;

  return (
    <AuthProvider tenantSlug={tenantSlug}>
      <TopBar tenantSlug={tenantSlug} />
      <div
        className="grid min-h-[calc(100vh-60px)] transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ gridTemplateColumns: collapsed ? "48px 1fr" : "256px 1fr" }}
      >
        <div className="overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]">
          <Sidebar tenantSlug={tenantSlug} collapsed={collapsed} onCollapse={toggle} />
        </div>
        <main className="min-w-0">{children}</main>
      </div>
    </AuthProvider>
  );
}
