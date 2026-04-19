"use client";

export function SectionHeader({ title, action }: { title: string; action?: { label: string; onClick?: () => void } }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">{title}</span>
      {action && (
        <button
          onClick={action.onClick}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function SettingsRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      {children}
    </div>
  );
}

export function SettingsTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
      {children}
    </div>
  );
}

export function Badge({ children, variant = "neutral" }: { children: React.ReactNode; variant?: "neutral" | "active" | "destructive" }) {
  const colors = {
    neutral: "bg-cream-2 text-ink-3",
    active: "bg-green/[0.12] text-green",
    destructive: "text-vermillion-2 hover:text-ink",
  };
  return (
    <span className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${colors[variant]}`}>
      {children}
    </span>
  );
}

export function Meta({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[10px] text-ink-4">{children}</span>;
}
