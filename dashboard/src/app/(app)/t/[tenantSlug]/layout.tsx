import { redirect } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { AuthProvider } from "@/lib/auth-context";
import { SidebarProvider } from "@/lib/sidebar-context";
import { SidebarShell } from "@/components/shell/SidebarShell";

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  if (!tenantSlug || tenantSlug === "undefined") {
    redirect("/");
  }

  return (
    <AuthProvider tenantSlug={tenantSlug}>
      <SidebarProvider>
        <TopBar tenantSlug={tenantSlug} />
        <SidebarShell tenantSlug={tenantSlug}>
          {children}
        </SidebarShell>
      </SidebarProvider>
    </AuthProvider>
  );
}
