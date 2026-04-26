"use client";

import { usePathname } from "next/navigation";
import { Breadcrumbs, PageHeader, StickyHeader } from "@/components/layouts";

const TITLES: Record<string, string> = {
  general: "General",
  "api-keys": "API Keys",
  "model-providers": "Model Endpoints",
  webhooks: "Webhooks",
};

export default function ProjectSettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const segment = pathname.split("/settings/")[1]?.split("/")[0] ?? "api-keys";
  const projectSlug = pathname.match(/\/projects\/([^/]+)/)?.[1] ?? "";
  const title = TITLES[segment] ?? "Settings";

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs items={[{ label: projectSlug }, { label: "Settings" }, { label: title }]} />
        <PageHeader title={title} />
      </StickyHeader>
      <div className="flex-1 overflow-y-auto px-10 pt-6 pb-8">
        {children}
      </div>
    </div>
  );
}
