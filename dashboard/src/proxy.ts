import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
  matcher: ["/t/:path*"],
};
