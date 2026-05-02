FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy workspace files for dependency resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY api/package.json api/
COPY packages/db/package.json packages/db/
COPY packages/types/package.json packages/types/
COPY packages/api-spec/package.json packages/api-spec/
COPY packages/pipeline/package.json packages/pipeline/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @koji/api...

# Copy source
COPY api/ api/
COPY packages/db/ packages/db/
COPY packages/types/ packages/types/
COPY packages/api-spec/ packages/api-spec/
COPY packages/pipeline/ packages/pipeline/

EXPOSE 9401

# Run migrations then start the API server
CMD ["sh", "-c", "cd packages/db && pnpm migrate || true && cd /app && pnpm --filter @koji/api start"]
