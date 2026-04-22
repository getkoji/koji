/**
 * Node entry point for the Koji API server.
 *
 * Reads `process.env` once at boot, builds the Node-friendly adapters
 * (LocalAuth / S3 / PostgresQueue / DockerParse), hands them to
 * `createApp(...)`, then serves the returned Hono app via `@hono/node-server`
 * and runs the in-process queue worker against the returned handlers.
 *
 * The edge runtime (Cloudflare Workers) has its own entry point in
 * `platform/apps/hosted` that calls the same `createApp(...)` with edge-
 * friendly adapters (Clerk / R2 / CloudflareQueue / Modal). Neither entry
 * point knows about the other — see `src/app.ts` for the contract.
 */

import { serve } from "@hono/node-server";

import { createDb, schema } from "@koji/db";
import { eq } from "drizzle-orm";

import { createApp } from "./app";
import { LocalAuthAdapter } from "./auth/local";
import { S3Storage } from "./storage/s3";
import { PostgresQueue } from "./queue/postgres";
import { startWorker } from "./queue/worker";
import { createParseProvider } from "./parse/factory";
import { SmtpEmailSender } from "./email/smtp";
import { markDocFailed } from "./ingestion/process";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/koji";
const PORT = parseInt(process.env.PORT ?? "9401", 10);
const AUTH_ADAPTER = process.env.KOJI_AUTH_ADAPTER ?? "local";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";
const PARSE_URL = process.env.KOJI_PARSE_URL ?? "http://koji-parse:9410";
const EXTRACT_URL = process.env.KOJI_EXTRACT_URL ?? "http://koji-extract:9420";
const MASTER_KEY = process.env.KOJI_MASTER_KEY ?? null;

const db = createDb(DATABASE_URL);
const auth = new LocalAuthAdapter(db);
const storage = new S3Storage({
  endpoint: process.env.KOJI_S3_ENDPOINT,
  publicEndpoint: process.env.KOJI_S3_PUBLIC_ENDPOINT,
  bucket: process.env.KOJI_S3_BUCKET ?? "koji",
  accessKey: process.env.KOJI_S3_ACCESS_KEY,
  secretKey: process.env.KOJI_S3_SECRET_KEY,
  region: process.env.KOJI_S3_REGION,
  forcePathStyle: process.env.KOJI_S3_FORCE_PATH_STYLE === "true",
});
const queue = new PostgresQueue(db);
const parseProvider = createParseProvider({
  backend: (process.env.KOJI_PARSE_BACKEND ?? "docker") as "docker" | "modal",
  dockerUrl: PARSE_URL,
  modalUrl: process.env.KOJI_PARSE_MODAL_URL,
  modalTokenId: process.env.MODAL_TOKEN_ID,
  modalTokenSecret: process.env.MODAL_TOKEN_SECRET,
});
const emailSender = new SmtpEmailSender({
  host: process.env.SMTP_HOST ?? "localhost",
  port: parseInt(process.env.SMTP_PORT ?? "1025", 10),
  from: process.env.SMTP_FROM ?? "koji@localhost",
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
});

const { app, handlers } = createApp({
  db,
  auth,
  storage,
  queue,
  parseProvider,
  emailSender,
  masterKey: MASTER_KEY,
  appUrl: APP_URL,
  extractUrl: EXTRACT_URL,
  parseUrl: PARSE_URL,
  authAdapterKind: AUTH_ADAPTER,
});

// Expose the adapter for any external caller that used to import `adapter`
// from this module (legacy route code has been migrated to `c.get("auth")`,
// so in practice nothing reaches for this — kept for now as a narrow
// back-door for scripts like `seed.ts` that run outside the request lifecycle).
export { auth as adapter };

async function start() {
  console.log(`[koji-api] Starting on port ${PORT}`);
  console.log(`[koji-api] Auth adapter: ${AUTH_ADAPTER}`);
  console.log(`[koji-api] Database: ${DATABASE_URL.replace(/:[^@]+@/, ":***@")}`);

  // In-process worker loop — Node-only. The hosted Workers deployment uses
  // the Cloudflare Queues consumer handler instead; see
  // `platform/apps/hosted/src/index.ts`.
  startWorker(queue, handlers, {
    onTerminalReap: async (job) => {
      if (job.kind === "ingestion.process") {
        const documentId = job.payload.documentId as string | undefined;
        if (!documentId) return;

        // Look up the document to find its jobId
        const [doc] = await db
          .select({
            jobId: schema.documents.jobId,
            status: schema.documents.status,
          })
          .from(schema.documents)
          .where(eq(schema.documents.id, documentId))
          .limit(1);

        if (!doc || doc.status !== "extracting") return;

        await markDocFailed(
          db,
          job.tenantId,
          documentId,
          doc.jobId,
          "Worker lost — job exceeded visibility timeout after max retries",
        );
        console.log(`[reaper] Marked document ${documentId} as failed`);
      }
    },
  });

  serve({ fetch: app.fetch, port: PORT });
  console.log(`[koji-api] Ready`);
}

start();
