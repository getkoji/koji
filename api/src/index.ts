import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { createDb } from "@koji/db";
import type { Db } from "@koji/db";
import type { Principal } from "./auth/adapter";

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

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/koji";
const PORT = parseInt(process.env.PORT ?? "9401", 10);
const AUTH_ADAPTER = process.env.KOJI_AUTH_ADAPTER ?? "local";

const db = createDb(DATABASE_URL);

// Create the auth adapter based on config
// TODO: add ClerkAuthAdapter, OIDCAuthAdapter
const adapter = new LocalAuthAdapter(db);

export type Env = { Variables: { db: Db; principal: Principal } };

const app = new Hono<Env>();

app.use("*", logger());
app.use("*", cors({ origin: (origin) => origin || "*", credentials: true }));

// Inject DB into every request
app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

// Auth middleware — validates session on every request (skips public routes)
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

// Export the adapter so setup.ts can create sessions
export { adapter };

// Start
async function start() {
  console.log(`[koji-api] Starting on port ${PORT}`);
  console.log(`[koji-api] Auth adapter: ${AUTH_ADAPTER}`);
  console.log(`[koji-api] Database: ${DATABASE_URL.replace(/:[^@]+@/, ":***@")}`);

  serve({ fetch: app.fetch, port: PORT });
  console.log(`[koji-api] Ready`);
}

start();
