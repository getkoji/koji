FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy all package.json files for workspace resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY dashboard/package.json dashboard/
COPY packages/ui/package.json packages/ui/
# Stub other workspace packages so pnpm resolves the lockfile
COPY api/package.json api/
COPY packages/db/package.json packages/db/
COPY packages/api-spec/package.json packages/api-spec/
COPY packages/types/package.json packages/types/
COPY packages/pipeline/package.json packages/pipeline/

RUN pnpm install --frozen-lockfile

# Copy source files without overwriting node_modules.
# We copy to a temp dir then merge, preserving the installed deps.
COPY dashboard/ /tmp/dashboard-src/
RUN cp -r /tmp/dashboard-src/src dashboard/src && \
    cp -r /tmp/dashboard-src/public dashboard/public && \
    cp /tmp/dashboard-src/next.config.ts dashboard/ && \
    cp /tmp/dashboard-src/tsconfig.json dashboard/ && \
    cp /tmp/dashboard-src/postcss.config.mjs dashboard/ && \
    cp /tmp/dashboard-src/eslint.config.mjs dashboard/ 2>/dev/null || true && \
    rm -rf /tmp/dashboard-src

COPY packages/ui/src packages/ui/src
COPY packages/ui/tsconfig.json packages/ui/tsconfig.json
COPY packages/ui/components.json packages/ui/components.json

RUN pnpm --filter @koji/dashboard build

FROM node:22-alpine AS runner

WORKDIR /app

COPY --from=builder /app/dashboard/.next/standalone ./
COPY --from=builder /app/dashboard/.next/static ./dashboard/.next/static
COPY --from=builder /app/dashboard/public ./dashboard/public

EXPOSE 3000

CMD ["node", "dashboard/server.js"]
