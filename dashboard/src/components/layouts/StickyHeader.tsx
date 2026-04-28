import type { ReactNode } from "react";

export function StickyHeader({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-[60px] z-10 bg-cream border-b border-border px-10 pt-5 pb-4 shrink-0">
      {children}
    </div>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-3">
      {items.map((item, i) => (
        <span key={i} className="contents">
          {i > 0 && <span className="text-cream-4">/</span>}
          {item.href ? (
            <a href={item.href} className="text-ink-3 hover:text-vermillion-2 transition-colors">
              {item.label}
            </a>
          ) : (
            <span className="text-ink font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({
  title,
  badge,
  meta,
  actions,
}: {
  title: string;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-8">
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1
            className="font-display text-[30px] font-medium leading-none tracking-tight text-ink m-0 truncate"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
            title={title}
          >
            {title}
          </h1>
          {badge}
        </div>
        {meta && <div className="flex items-center gap-2.5 font-mono text-[11px] text-ink-4">{meta}</div>}
      </div>
      {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
