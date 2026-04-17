import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { createDb } from "@koji/db";
import type { Db } from "@koji/db";

import { health } from "./routes/health";
import { schemas } from "./routes/schemas";
import { jobs } from "./routes/jobs";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/koji";
const PORT = parseInt(process.env.PORT ?? "9401", 10);

const db = createDb(DATABASE_URL);

export type Env = { Variables: { db: Db } };

const app = new Hono<Env>();

app.use("*", logger());
app.use("*", cors());

// Inject DB into every request
app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

// Routes
app.route("/health", health);
app.route("/api/schemas", schemas);
app.route("/api/jobs", jobs);

console.log(`[koji-api] Starting on port ${PORT}`);
console.log(`[koji-api] Database: ${DATABASE_URL.replace(/:[^@]+@/, ":***@")}`);

serve({ fetch: app.fetch, port: PORT });
