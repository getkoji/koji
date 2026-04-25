/**
 * `createApp` — build a Hono app from injected adapters.
 *
 * This is the seam between the OSS product and the runtime that hosts it:
 *
 *   - The **Node entry** (`src/index.ts`) reads `process.env`, creates Node-
 *     friendly adapters (LocalAuth, S3, PostgresQueue, DockerParse), calls
 *     `createApp(...)`, and serves the returned `app` via `@hono/node-server`.
 *     It also runs the in-process worker loop against the returned `handlers`.
 *
 *   - The **Cloudflare Workers entry** (in `platform/apps/hosted`) reads
 *     `env.*` bindings, creates edge-friendly adapters (Clerk, R2, Cloudflare
 *     Queues, Modal), calls `createApp(...)`, and dispatches HTTP requests to
 *     the returned `app` via `export default { fetch }`. Queue messages are
 *     dispatched via `export default { queue }` and execute handlers from the
 *     returned `handlers` registry — no polling loop needed.
 *
 * Neither caller knows about the other. The app itself has no `process.env`
 * reads at the top level — all config flows through the deps object and is
 * published onto the Hono request context so route handlers can pull it
 * regardless of runtime.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";

import type { Db } from "@koji/db";
import type { AuthAdapter } from "./auth/adapter";
import { authMiddleware, type AuthMiddlewareOptions } from "./auth/middleware";
import type { BillingAdapter } from "./billing/adapter";
import { NoOpBillingAdapter } from "./billing/noop";
import type { StorageProvider } from "./storage/provider";
import type { QueueProvider, HandlerMap } from "./queue/provider";
import type { ParseProvider } from "./parse/provider";
import type { EmailSender } from "./email/provider";

// Routes
import { createAuthRoutes } from "./routes/auth";
import { passwordReset } from "./routes/password-reset";
import { health } from "./routes/health";
import { schemas } from "./routes/schemas";
import { jobs } from "./routes/jobs";
import { extract as extractRoutes } from "./routes/extract";
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
import { pipelinesRouter } from "./routes/pipelines";
import { review } from "./routes/review";
import { overview } from "./routes/overview";
import { billing as billingRoutes } from "./routes/billing";

// Background-job wiring
import { initEmitter } from "./webhooks/emit";
import { initDeliveryHandler, handleWebhookDeliver } from "./webhooks/deliver";
import {
  initIngestionHandler,
  initParseProvider,
  initBilling,
  handleIngestionProcess,
} from "./ingestion/process";

import type { Env } from "./env";

export interface CreateAppDeps {
  db: Db;
  /** Optional per-request DB factory. When provided, each request gets a
   *  fresh DB connection instead of reusing `db`. Required for Cloudflare
   *  Workers where TCP sockets can't be shared across request contexts.
   *  The static `db` is still used for app initialization. */
  dbFactory?: () => Db;
  /** Optional per-request auth adapter factory. When dbFactory is set, the
   *  auth adapter also needs a fresh DB per request (it queries users). */
  authFactory?: (db: Db) => AuthAdapter;
  auth: AuthAdapter;
  storage: StorageProvider;
  queue: QueueProvider;
  parseProvider: ParseProvider;
  emailSender: EmailSender;

  /** 64-hex master key for envelope encryption. May be `null` in read-only
   *  deployments, but any route that needs to encrypt/decrypt (webhook
   *  targets, sources, model providers) will 500 without it. */
  masterKey: string | null;

  /** Public dashboard URL — used in invite / password-reset emails. */
  appUrl: string;
  /** Base URL for the extract service. */
  extractUrl: string;
  /** Base URL for the parse service (only hit directly by Node `routes/extract.ts`;
   *  Workers go through the parseProvider). */
  parseUrl: string;

  /** Short label for the active auth adapter: `"local"` | `"clerk"` | `"oidc"`.
   *  Surfaced to setup/me routes so the UI knows which flows to show. */
  authAdapterKind: string;

  /** CORS config. Defaults to "*" for local dev; hosted should lock this to
   *  the dashboard origin. */
  cors?: Parameters<typeof cors>[0];

  /** Hono logger toggle. Default: on. Turn off for cleaner Workers logs. */
  requestLogger?: boolean;

  /** Auth middleware options — notably the cookie name Clerk uses
   *  (`__session`) vs the local default (`koji_session`). */
  authMiddleware?: AuthMiddlewareOptions;

  /** Billing adapter. Defaults to NoOpBillingAdapter (all gates pass,
   *  no usage tracking) for self-hosted / OSS deployments. */
  billing?: BillingAdapter;
}

export interface CreateAppResult {
  /** The Hono app. Node: pass `app.fetch` to `serve()`. Workers: put
   *  `export default { fetch: app.fetch }`. */
  app: Hono<Env>;

  /** Background-job handler registry — Node worker loop consumes these via
   *  `startWorker(queue, handlers)`; Workers queue consumer looks up
   *  `handlers[message.kind]` and invokes it on each message. */
  handlers: HandlerMap;
}

export function createApp(deps: CreateAppDeps): CreateAppResult {
  const billing = deps.billing ?? new NoOpBillingAdapter();

  // Initialize module-level state that the job handlers read. All three
  // of these are idempotent — calling them more than once just overwrites
  // the previously captured refs, which is the behaviour Workers isolates
  // rely on (module scope persists within an isolate, and re-initialising
  // on every `fetch` would be wasteful; initialising once at app creation
  // is what we want).
  initEmitter(deps.queue, deps.db);
  initDeliveryHandler(deps.db, deps.masterKey);
  initIngestionHandler(deps.db, deps.storage, { extractUrl: deps.extractUrl });
  initParseProvider(deps.parseProvider);
  initBilling(billing);

  const app = new Hono<Env>();

  if (deps.requestLogger !== false) {
    app.use("*", honoLogger());
  }

  app.use(
    "*",
    cors(
      deps.cors ?? {
        origin: (origin) => origin || "*",
        credentials: true,
      },
    ),
  );

  // Per-request injection — adapters + config become available via c.get(...)
  // inside every route handler and downstream middleware.
  const injectContext: MiddlewareHandler<Env> = async (c, next) => {
    const requestDb = deps.dbFactory ? deps.dbFactory() : deps.db;
    const requestAuth = deps.authFactory ? deps.authFactory(requestDb) : deps.auth;
    c.set("db", requestDb);
    c.set("storage", deps.storage);
    c.set("queue", deps.queue);
    c.set("auth", requestAuth);
    c.set("emailSender", deps.emailSender);
    c.set("masterKey", deps.masterKey);
    c.set("appUrl", deps.appUrl);
    c.set("extractUrl", deps.extractUrl);
    c.set("parseUrl", deps.parseUrl);
    c.set("authAdapterKind", deps.authAdapterKind);
    c.set("billing", billing);
    c.set("parseProvider", deps.parseProvider);
    await next();
  };
  app.use("*", injectContext);

  // Auth middleware — validates session, resolves tenant, loads grants
  app.use("*", authMiddleware(deps.auth, deps.authMiddleware ?? {}));

  // Routes
  app.route("/health", health);
  app.route("/api/health", health);
  app.route("/api/auth", createAuthRoutes(deps.auth));
  app.route("/api/auth", passwordReset);
  app.route("/api/schemas", schemas);
  app.route("/api/jobs", jobs);
  app.route("/api", extractRoutes);
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
  app.route("/api/pipelines", pipelinesRouter);
  app.route("/api/review", review);
  app.route("/api/overview", overview);
  app.route("/api/billing", billingRoutes);

  const handlers: HandlerMap = {
    "webhook.deliver": handleWebhookDeliver,
    "ingestion.process": handleIngestionProcess,
  };

  return { app, handlers };
}
