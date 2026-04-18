"use client";

import { useAuth } from "@/lib/auth-context";

/**
 * Conditionally renders children based on the current user's permissions.
 *
 * - If allowed: renders children normally
 * - If denied + fallback: renders the fallback (e.g., disabled button with tooltip)
 * - If denied + no fallback: renders nothing
 *
 * Per spec: prefer disabled-with-tooltip over hiding entirely, so users
 * know the action exists but they lack permission.
 */
export function PermissionGate({
  permission,
  fallback,
  children,
}: {
  permission: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { hasPermission, loading } = useAuth();

  if (loading) return null;

  if (hasPermission(permission)) {
    return <>{children}</>;
  }

  return fallback ? <>{fallback}</> : null;
}
