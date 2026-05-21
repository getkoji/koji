import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Proxy /api/* requests to the Koji API server.
 *
 * In Docker, the dashboard and API are separate containers. The browser
 * hits the dashboard on one port, and API calls need to reach a different
 * container. This middleware rewrites /api/* to the Koji API URL at
 * runtime (not build time), eliminating the NEXT_PUBLIC_API_URL problem.
 */
// Next.js standalone middleware can't read runtime env vars reliably.
// We use KOJI_API_INTERNAL which is set at build time by the Dockerfile
// for Docker deployments, and falls back to KOJI_API_URL at runtime
// for non-Docker (dev server) usage.
const API_TARGET =
  process.env.KOJI_API_INTERNAL ??
  process.env.KOJI_API_URL ??
  "http://localhost:9401";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Expose the API URL to the client for SSE/streaming endpoints
  // that can't go through the middleware proxy (timeout issues).
  if (pathname === "/_koji/api-url") {
    return NextResponse.json({ url: API_TARGET });
  }

  if (pathname.startsWith("/api/")) {
    const target = new URL(pathname + request.nextUrl.search, API_TARGET);

    return NextResponse.rewrite(target, {
      request: {
        headers: request.headers,
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/_koji/:path*"],
};
