"use client";

import { usePathname } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@koji/ui";
import { TopBar } from "@/components/shell/TopBar";
import { AppSidebar } from "@/components/shell/Sidebar";
import { AuthProvider } from "@/lib/auth-context";

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";

  if (!tenantSlug || tenantSlug === "undefined") return null;

  return (
    <AuthProvider tenantSlug={tenantSlug}>
      <SidebarProvider>
        <AppSidebar tenantSlug={tenantSlug} />
        <SidebarInset className="bg-cream">
          <TopBar tenantSlug={tenantSlug} />
          <main className="min-w-0 flex-1">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </AuthProvider>
  );
}
