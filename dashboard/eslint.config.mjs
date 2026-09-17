import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored pdf.js build output, copied verbatim out of node_modules by
    // scripts/copy-pdfjs-assets.mjs. Not ours to fix, and linting the 450KB
    // openjpeg fallback buries real findings under ~70 generated-code errors.
    "public/**",
  ]),
]);

export default eslintConfig;
