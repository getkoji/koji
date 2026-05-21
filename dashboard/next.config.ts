import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  // Proxy /api/* to the Koji API server so the dashboard can use
  // relative URLs. This eliminates the NEXT_PUBLIC_API_URL build-time
  // baking problem — the API URL is resolved at runtime via the
  // KOJI_API_URL env var (defaults to http://localhost:9401).
  async rewrites() {
    const apiUrl = process.env.KOJI_API_URL ?? "http://localhost:9401";
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
