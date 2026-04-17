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
}

const SettingsExtensionsContext = createContext<SettingsExtensions>({
  navItems: [],
  titleMap: {},
});

export function SettingsExtensionsProvider({
  navItems = [],
  titleMap = {},
  children,
}: {
  navItems?: SettingsNavItem[];
  titleMap?: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <SettingsExtensionsContext.Provider value={{ navItems, titleMap }}>
      {children}
    </SettingsExtensionsContext.Provider>
  );
}

export function useSettingsExtensions(): SettingsExtensions {
  return useContext(SettingsExtensionsContext);
}
