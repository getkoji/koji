import { redirect } from "next/navigation";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; projectSlug: string }>;
}) {
  const { tenantSlug, projectSlug } = await params;
  redirect(`/t/${tenantSlug}/projects/${projectSlug}/settings/general`);
}
