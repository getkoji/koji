import { TopBar } from "@/components/shell/TopBar";
import { Sidebar } from "@/components/shell/Sidebar";

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  return (
    <>
      <TopBar tenantSlug={tenantSlug} />
      <div className="grid min-h-[calc(100vh-60px)]" style={{ gridTemplateColumns: "256px 1fr" }}>
        <Sidebar tenantSlug={tenantSlug} />
        <main className="px-10 py-8 pb-16 min-w-0">{children}</main>
      </div>
    </>
  );
}
