FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY dashboard/package.json dashboard/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile --filter @koji/dashboard...

COPY dashboard/ dashboard/
COPY packages/ui/ packages/ui/

RUN pnpm --filter @koji/dashboard build

FROM node:22-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY --from=builder /app/dashboard/.next/standalone ./
COPY --from=builder /app/dashboard/.next/static ./.next/static
COPY --from=builder /app/dashboard/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
