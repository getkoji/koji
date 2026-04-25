"use client";

import { useParams } from "next/navigation";
import { redirect } from "next/navigation";

/**
 * Model Catalog has been removed. Redirect to the Model Endpoints
 * settings page, which is the single place to configure models.
 */
export default function ModelCatalogRedirect() {
  const params = useParams<{ tenantSlug: string }>();
  const tenantSlug = params?.tenantSlug ?? "";
  redirect(`/t/${tenantSlug}/settings/general`);
}
