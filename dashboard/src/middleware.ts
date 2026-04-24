import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";
const isHosted = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const PUBLIC_PATHS = ["/setup", "/login", "/sign-up", "/sign-in", "/new-project", "/forgot-password", "/reset-password", "/accept-invite", "/cli/authorize"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // Setup check (both modes)
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

  // Auth check — Clerk uses __session cookie, OSS uses koji_session
  if (pathname.startsWith("/t/") || pathname === "/") {
    const sessionCookie = isHosted
      ? request.cookies.get("__session")?.value
      : request.cookies.get("koji_session")?.value;

    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // Validate against the API
    let valid = false;
    try {
      const cookieHeader = isHosted
        ? `__session=${sessionCookie}`
        : `koji_session=${sessionCookie}`;
      const res = await fetch(`${API_BASE}/api/me`, {
        headers: {
          Cookie: cookieHeader,
          "Content-Type": "application/json",
        },
      });
      valid = res.ok;
    } catch {
      valid = true; // API unreachable — don't boot the user
    }

    if (!valid) {
      const response = NextResponse.redirect(new URL("/login", request.url));
      if (!isHosted) response.cookies.delete("koji_session");
      return response;
    }
  }

  // Tenant header + active tenant cookie
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
