import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { createDb } from "@koji/db";

import { LocalAuthAdapter } from "./auth/local";
import { authMiddleware } from "./auth/middleware";
import { createAuthRoutes } from "./routes/auth";
import { passwordReset } from "./routes/password-reset";
import { health } from "./routes/health";
import { schemas } from "./routes/schemas";
import { jobs } from "./routes/jobs";
import { extract } from "./routes/extract";
import { me } from "./routes/me";
import { setup } from "./routes/setup";
import { tenants } from "./routes/tenants";
import { projects } from "./routes/projects";
import { invites } from "./routes/invites";
import { members } from "./routes/members";
import { apiKeys } from "./routes/api-keys";
import { cliAuth } from "./routes/cli-auth";
import { modelProviders } from "./routes/model-providers";
import { modelCatalog } from "./routes/model-catalog";
import { webhookTargets } from "./routes/webhook-targets";
import { sources } from "./routes/sources";
import { PostgresQueue } from "./queue/postgres";
import { startWorker } from "./queue/worker";
import { initEmitter } from "./webhooks/emit";
import { initDeliveryHandler, handleWebhookDeliver } from "./webhooks/deliver";
import type { Env } from "./env";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/koji";
const PORT = parseInt(process.env.PORT ?? "9401", 10);
const AUTH_ADAPTER = process.env.KOJI_AUTH_ADAPTER ?? "local";

const db = createDb(DATABASE_URL);

// Create the auth adapter based on config
const adapter = new LocalAuthAdapter(db);

const app = new Hono<Env>();

app.use("*", logger());
app.use("*", cors({ origin: (origin) => origin || "*", credentials: true }));

// Inject DB into every request
app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

// Auth middleware — validates session, resolves tenant, loads grants
app.use("*", authMiddleware(adapter));

// Routes
app.route("/health", health);
app.route("/api/auth", createAuthRoutes(adapter));
app.route("/api/auth", passwordReset);
app.route("/api/schemas", schemas);
app.route("/api/jobs", jobs);
app.route("/api", extract);
app.route("/api/me", me);
app.route("/api/setup", setup);
app.route("/api/tenants", tenants);
app.route("/api/projects", projects);
app.route("/api/invites", invites);
app.route("/api/members", members);
app.route("/api/api-keys", apiKeys);
app.route("/api/cli", cliAuth);
app.route("/api/model-providers", modelProviders);
app.route("/api/model-catalog", modelCatalog);
app.route("/api/webhook-targets", webhookTargets);
app.route("/api/sources", sources);

// Export the adapter so setup.ts can create sessions
export { adapter };

// Start
async function start() {
  console.log(`[koji-api] Starting on port ${PORT}`);
  console.log(`[koji-api] Auth adapter: ${AUTH_ADAPTER}`);
  console.log(`[koji-api] Database: ${DATABASE_URL.replace(/:[^@]+@/, ":***@")}`);

  // Initialize queue + webhook system
  const queue = new PostgresQueue(db);
  initEmitter(queue, db);
  initDeliveryHandler(db);

  // Start background worker
  startWorker(queue, {
    "webhook.deliver": handleWebhookDeliver,
  });

  serve({ fetch: app.fetch, port: PORT });
  console.log(`[koji-api] Ready`);
}

start();
