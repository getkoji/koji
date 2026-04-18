"use client";

import { createContext, useContext, useCallback, useMemo } from "react";
import { useApi } from "./use-api";
import { api, type UserProfile } from "./api";

interface AuthGrants {
  roles: string[];
  permissions: string[];
}

interface AuthContextValue {
  user: UserProfile | null;
  grants: AuthGrants | null;
  loading: boolean;
  /** Check if the current user has a specific permission in this tenant. */
  hasPermission: (permission: string) => boolean;
  /** Check if the current user has any of the given permissions. */
  hasAnyPermission: (...permissions: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  grants: null,
  loading: true,
  hasPermission: () => false,
  hasAnyPermission: () => false,
});

export function AuthProvider({
  tenantSlug,
  children,
}: {
  tenantSlug: string;
  children: React.ReactNode;
}) {
  const { data: user, loading: userLoading } = useApi(
    useCallback(() => api.get<UserProfile>("/api/me"), []),
  );

  const { data: grants, loading: grantsLoading } = useApi(
    useCallback(
      () => api.get<AuthGrants>(`/api/me/grants?tenant=${tenantSlug}`),
      [tenantSlug],
    ),
  );

  const permissionSet = useMemo(
    () => new Set(grants?.permissions ?? []),
    [grants],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user: user ?? null,
      grants: grants ?? null,
      loading: userLoading || grantsLoading,
      hasPermission: (p: string) => permissionSet.has(p),
      hasAnyPermission: (...ps: string[]) => ps.some((p) => permissionSet.has(p)),
    }),
    [user, grants, userLoading, grantsLoading, permissionSet],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
