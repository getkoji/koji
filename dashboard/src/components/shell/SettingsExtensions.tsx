"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface SettingsNavItem {
  href: string;
  icon: ReactNode;
  label: string;
}

interface SettingsExtensions {
  navItems: SettingsNavItem[];
  titleMap: Record<string, string>;
  /** When true, the sidebar hides the default General/Members sub-nav items. */
  hideDefaultNav: boolean;
}

const SettingsExtensionsContext = createContext<SettingsExtensions>({
  navItems: [],
  titleMap: {},
  hideDefaultNav: false,
});

export function SettingsExtensionsProvider({
  navItems = [],
  titleMap = {},
  hideDefaultNav = false,
  children,
}: {
  navItems?: SettingsNavItem[];
  titleMap?: Record<string, string>;
  hideDefaultNav?: boolean;
  children: ReactNode;
}) {
  return (
    <SettingsExtensionsContext.Provider value={{ navItems, titleMap, hideDefaultNav }}>
      {children}
    </SettingsExtensionsContext.Provider>
  );
}

export function useSettingsExtensions(): SettingsExtensions {
  return useContext(SettingsExtensionsContext);
}
