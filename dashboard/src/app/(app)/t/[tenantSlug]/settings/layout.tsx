"use client";

import { usePathname } from "next/navigation";
import { Breadcrumbs, PageHeader, StickyHeader } from "@/components/layouts";

const SETTINGS_TITLES: Record<string, string> = {
  members: "Members",
  "api-keys": "API Keys",
  endpoints: "Endpoints",
  webhooks: "Webhooks",
  billing: "Billing",
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const segment = pathname.split("/settings/")[1]?.split("/")[0] ?? "members";
  const title = SETTINGS_TITLES[segment] ?? "Settings";

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs items={[{ label: "Settings" }, { label: title }]} />
        <PageHeader title={title} />
      </StickyHeader>
      <div className="flex-1 overflow-y-auto px-10 pt-6 pb-8">
        {children}
      </div>
    </div>
  );
}
