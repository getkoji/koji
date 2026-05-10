import type { ReactNode } from "react";
import { StickyHeader } from "./StickyHeader";

export function DetailLayout({
  header,
  metricsStrip,
  sidebar,
  sidebarWidth,
  children,
}: {
  header: ReactNode;
  metricsStrip?: ReactNode;
  sidebar: ReactNode;
  sidebarWidth?: string;
  children: ReactNode;
}) {
  const cols = sidebarWidth ?? "0.42fr";

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>{header}</StickyHeader>
      <div className="flex-1 min-h-0 flex flex-col">
        {metricsStrip && <div className="px-10 pt-5 shrink-0">{metricsStrip}</div>}
        <div
          className="flex-1 min-h-0 grid gap-4 px-10 pt-5 pb-8"
          style={{ gridTemplateColumns: `${cols} 1fr` }}
        >
          <div className="overflow-y-auto min-h-0">{sidebar}</div>
          <div className="overflow-y-auto min-h-0">{children}</div>
        </div>
      </div>
    </div>
  );
}
