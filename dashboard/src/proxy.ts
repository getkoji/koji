import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";

// Routes that don't require auth
const PUBLIC_PATHS = ["/setup", "/login", "/new-project", "/forgot-password", "/reset-password", "/accept-invite", "/cli/authorize"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static assets pass through
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Public routes pass through
  if (PUBLIC_PATHS.some((p) => pathname === p)) {
    return NextResponse.next();
  }

  // Check if setup is needed (empty DB)
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
      // API unreachable — let the page render
    }
  }

  // Validate the session. Cookie presence alone isn't enough — a stale or
  // forged cookie would let the shell + tenant-scoped pages render their
  // chrome even though every data fetch inside would fail with 401. Hit
  // the API's authenticated `/api/me` endpoint with the cookie and treat
  // any non-2xx as "not signed in", clearing the stale cookie and routing
  // back through /login.
  if (pathname.startsWith("/t/") || pathname === "/") {
    const sessionCookie = request.cookies.get("koji_session")?.value;
    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    let valid = false;
    try {
      const res = await fetch(`${API_BASE}/api/me`, {
        headers: {
          Cookie: `koji_session=${sessionCookie}`,
          "Content-Type": "application/json",
        },
      });
      valid = res.ok;
    } catch {
      // API unreachable. Don't boot the user just because the API is down —
      // let the page render and surface the real error via its own fetch.
      valid = true;
    }

    if (!valid) {
      const response = NextResponse.redirect(new URL("/login", request.url));
      response.cookies.delete("koji_session");
      return response;
    }
  }

  // Set tenant header for tenant-scoped routes + remember the last-used
  // tenant in a cookie so the root '/' redirect can land the user back
  // in the workspace they were working in.
  if (pathname.startsWith("/t/")) {
    const parts = pathname.split("/");
    const tenantSlug = parts[2];
    if (tenantSlug) {
      const headers = new Headers(request.headers);
      headers.set("x-koji-tenant", tenantSlug);
      const response = NextResponse.next({ headers });
      response.cookies.set("koji_active_tenant", tenantSlug, {
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
