"use client";

import { useParams, redirect } from "next/navigation";
import { usePageTitle } from "@/lib/use-page-title";

/**
 * API keys moved to workspace settings.
 *
 * A key can span projects — all-access keys belong to no project at all — so
 * "which keys exist" is a workspace question, not a per-project one. Managing
 * them from inside a project meant a multi-project key appeared once per
 * project it touched, and there was no single place to see the whole set.
 * This path stays as a redirect so old links and bookmarks keep working.
 */
export default function ProjectApiKeysRedirect() {
  usePageTitle("API Keys");
  const params = useParams<{ tenantSlug: string }>();
  const tenantSlug = params?.tenantSlug ?? "";
  redirect(`/t/${tenantSlug}/settings/api-keys`);
}
