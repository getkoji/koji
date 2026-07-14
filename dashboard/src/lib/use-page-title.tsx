"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const DEFAULT_BRAND = "Koji";

const SetTitleContext = createContext<(title: string | null) => void>(() => {});

/**
 * Owns the browser tab / history title for the whole app.
 *
 * The dashboard is overwhelmingly built from Client Components, which can't
 * use Next.js `export const metadata` (Server-only). Setting `document.title`
 * from a `useEffect` is unreliable here: on a hard page load Next's metadata
 * machinery re-asserts the layout's default title *after* the effect runs, so
 * the effect's value is clobbered (it only "sticks" after a client-side
 * navigation). Verified live against the production build.
 *
 * Instead we render a real `<title>` element. React 19 hoists it into
 * `<head>` and manages it through reconciliation, so it wins deterministically
 * over any effect-timing race — and it's the only `<title>` in the tree
 * (the root layout intentionally sets no metadata title), so there's no
 * duplicate to fight with. Pages push their name in via {@link usePageTitle};
 * this provider turns it into "<name> · <brand>" (or just the brand when
 * unset). `brand` defaults to "Koji"; the hosted console passes "Koji Console".
 */
export function PageTitleProvider({
  children,
  brand = DEFAULT_BRAND,
}: {
  children: ReactNode;
  brand?: string;
}) {
  const [title, setTitle] = useState<string | null>(null);
  const trimmed = title?.trim();
  const resolved = trimmed ? `${trimmed} · ${brand}` : brand;
  return (
    <SetTitleContext.Provider value={setTitle}>
      <title>{resolved}</title>
      {children}
    </SetTitleContext.Provider>
  );
}

/**
 * Sets the browser tab / history title for the current page. Call once per
 * page with the page's name; the document title becomes "<name> · Koji".
 *
 * Pass a nullish/empty title (e.g. while an entity name is still loading) and
 * it falls back to just "Koji" rather than "undefined · Koji". When the name
 * resolves, pass it and the title updates in place. On unmount the title
 * resets to the "Koji" default so a page that forgets to set one never
 * inherits the previous page's title.
 */
export function usePageTitle(title?: string | null): void {
  const setTitle = useContext(SetTitleContext);
  useEffect(() => {
    setTitle(title ?? null);
    return () => setTitle(null);
  }, [setTitle, title]);
}
