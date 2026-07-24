"use client";

import Link from "next/link";

/**
 * Sub-navigation for a classifier: config → corpus → validate, mirroring the
 * schema tab idiom. Link-based because each tab is its own route.
 */
export function ClassifierTabs({
  base,
  slug,
  active,
}: {
  base: string; // `/t/${tenantSlug}`
  slug: string;
  active: "config" | "corpus" | "validate";
}) {
  const tabs = [
    { key: "config", label: "Config", href: `${base}/classifiers/${slug}` },
    { key: "corpus", label: "Corpus", href: `${base}/classifiers/${slug}/corpus` },
    { key: "validate", label: "Validate", href: `${base}/classifiers/${slug}/validate` },
  ] as const;

  return (
    <nav className="flex items-center gap-1 border-b border-border mb-5">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`relative px-3 py-2 text-[12.5px] font-medium transition-colors ${
            t.key === active
              ? "text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-vermillion-2"
              : "text-ink-4 hover:text-ink-2"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
