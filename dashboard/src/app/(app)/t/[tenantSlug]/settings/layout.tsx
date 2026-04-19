"use client";

import { usePathname } from "next/navigation";
import { Breadcrumbs, PageHeader, StickyHeader } from "@/components/layouts";
import { useSettingsExtensions } from "@/components/shell/SettingsExtensions";

const TITLES: Record<string, string> = {
  general: "General",
  members: "Members",
  "model-catalog": "Model Catalog",
};

export default function TenantSettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { titleMap: extensionTitles } = useSettingsExtensions();
  const segment = pathname.split("/settings/")[1]?.split("/")[0] ?? "members";
  const title = TITLES[segment] ?? extensionTitles[segment] ?? "Settings";

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs items={[{ label: "Organization" }, { label: title }]} />
        <PageHeader title={title} />
      </StickyHeader>
      <div className="flex-1 overflow-y-auto px-10 pt-6 pb-8">
        {children}
      </div>
    </div>
  );
}
