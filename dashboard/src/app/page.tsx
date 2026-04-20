import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";

/**
 * Root redirect. Runs server-side so the user never sees a loading
 * flash; the proxy middleware guarantees we reach here only when
 * setup is complete and a session cookie exists. We still validate
 * the session via /api/tenants — if it's invalid, send them back to
 * /login rather than silently continuing to a broken page.
 *
 * Destinations:
 *   - no session cookie        → /login
 *   - session invalid (401)    → /login
 *   - authenticated, 0 tenants → /new-project
 *   - authenticated, N tenants → /t/{slug} using koji_active_tenant
 *                                cookie when it matches a membership,
 *                                otherwise the first tenant.
 */
export default async function RootPage() {
  const cookieStore = await cookies();
  const session = cookieStore.get("koji_session")?.value;

  if (!session) redirect("/login");

  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}/api/tenants`, {
      headers: { Cookie: `koji_session=${session}` },
      cache: "no-store",
    });
  } catch {
    redirect("/login");
  }

  if (!resp.ok) redirect("/login");

  const payload = (await resp.json()) as {
    data: Array<{ slug: string; displayName: string }>;
  };
  const tenants = payload.data ?? [];

  if (tenants.length === 0) redirect("/new-project");

  const active = cookieStore.get("koji_active_tenant")?.value;
  const target = tenants.find((t) => t.slug === active) ?? tenants[0]!;

  redirect(`/t/${target.slug}`);
}
