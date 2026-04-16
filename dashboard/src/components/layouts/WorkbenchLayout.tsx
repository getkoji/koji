import type { ReactNode } from "react";
import { StickyHeader } from "./StickyHeader";

export function WorkbenchLayout({
  header,
  metricsStrip,
  toolbar,
  panes,
  columns,
}: {
  header: ReactNode;
  metricsStrip?: ReactNode;
  toolbar?: ReactNode;
  panes: ReactNode[];
  columns?: string;
}) {
  const cols = columns ?? panes.map(() => "1fr").join(" ");

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>{header}</StickyHeader>
      <div className="flex-1 min-h-0 flex flex-col">
        {metricsStrip && <div className="px-10 pt-5 shrink-0">{metricsStrip}</div>}
        {toolbar && (
          <div className="px-10 py-3 shrink-0 border-b border-border flex items-center justify-between gap-4">
            {toolbar}
          </div>
        )}
        <div
          className="flex-1 min-h-0 grid gap-px bg-border"
          style={{ gridTemplateColumns: cols }}
        >
          {panes.map((pane, i) => (
            <div key={i} className="overflow-y-auto min-h-0 bg-cream">
              {pane}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
