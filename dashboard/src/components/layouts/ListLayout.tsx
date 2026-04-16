import type { ReactNode } from "react";
import { StickyHeader } from "./StickyHeader";

export function ListLayout({
  header,
  metricsStrip,
  filterBar,
  children,
}: {
  header: ReactNode;
  metricsStrip?: ReactNode;
  filterBar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>{header}</StickyHeader>
      <div className="flex-1 min-h-0 flex flex-col">
        {metricsStrip && <div className="px-10 pt-5 shrink-0">{metricsStrip}</div>}
        {filterBar && (
          <div className="px-10 pt-4 pb-2 shrink-0 border-b border-border">{filterBar}</div>
        )}
        <div className="flex-1 overflow-y-auto px-10 pt-4 pb-8">{children}</div>
      </div>
    </div>
  );
}
