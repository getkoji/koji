import { redirect } from "next/navigation";

/**
 * Tenant root redirects to the default project overview.
 * The tenant slug doubles as the default project slug — same convention the
 * sidebar and project settings already use.
 */
export default async function TenantRootPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  redirect(`/t/${tenantSlug}/projects/${tenantSlug}`);
}
