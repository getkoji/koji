import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Dashboard unit-test config — vitest for pure-TS helpers (parsers,
 * adapters, formatters). React component tests would need jsdom +
 * @testing-library/react; we deliberately don't pull those in yet. End-to-end
 * Playwright suites live under `e2e/` and are excluded here.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules/**", "e2e/**", ".next/**"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
