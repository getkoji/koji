import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow /setup and static assets through without checks
  if (pathname === "/setup" || pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // For all app routes, check if setup is needed
  if (pathname === "/" || pathname.startsWith("/t/")) {
    try {
      const res = await fetch(`${API_BASE}/api/setup/status`, {
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const status = await res.json();
        if (status.needed) {
          return NextResponse.redirect(new URL("/setup", request.url));
        }
      }
    } catch {
      // API unreachable — let the page render (it'll show its own error)
    }
  }

  // Set tenant header for tenant-scoped routes
  if (pathname.startsWith("/t/")) {
    const parts = pathname.split("/");
    const tenantSlug = parts[2];
    if (tenantSlug) {
      const headers = new Headers(request.headers);
      headers.set("x-koji-tenant", tenantSlug);
      return NextResponse.next({ headers });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
