import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
      {icon && <div className="text-ink-4 mb-4">{icon}</div>}
      <h3
        className="font-display text-lg font-medium text-ink mb-1"
        style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
      >
        {title}
      </h3>
      {description && <p className="text-[13px] text-ink-3 max-w-[40ch] mb-4">{description}</p>}
      {action}
    </div>
  );
}
