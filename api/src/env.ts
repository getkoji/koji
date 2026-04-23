import type { Db } from "@koji/db";
import type { AuthAdapter, Principal } from "./auth/adapter";
import type { Permission } from "./auth/roles";
import type { BillingAdapter } from "./billing/adapter";
import type { EmailSender } from "./email/provider";
import type { QueueProvider } from "./queue/provider";
import type { StorageProvider } from "./storage/provider";

/**
 * Per-request Hono context.
 *
 * Adapters (db, auth, storage, queue) and config that used to be read from
 * `process.env` module-level constants (master key, app URL, extract URL)
 * are injected once in `createApp` and then pulled off the context inside
 * route handlers. This keeps route code free of ambient env reads so the
 * same handlers can run under Node and under Cloudflare Workers.
 */
export type Env = {
  Variables: {
    db: Db;
    principal: Principal;
    tenantId: string;
    grants: Set<Permission>;
    roles: string[];
    storage: StorageProvider;
    queue: QueueProvider;
    /** Auth adapter, for routes that create sessions (setup, invites). On
     *  Workers/Clerk this adapter's `createSession` throws — setup/invites
     *  are Node-only flows. */
    auth: AuthAdapter;
    /** Outbound email sender for invite + password-reset flows. Self-hosted
     *  wires an SMTP sender; hosted can wire an HTTP-based sender or a no-op
     *  when Clerk handles user-lifecycle emails itself. */
    emailSender: EmailSender;
    /** 64-hex master key for envelope encryption; null if not configured. */
    masterKey: string | null;
    /** Public URL of the dashboard — used in password-reset and invite emails. */
    appUrl: string;
    /** Base URL for the extract service (self-hosted sidecar or hosted proxy). */
    extractUrl: string;
    /** Base URL for the parse service (self-hosted sidecar; Workers path uses a
     *  parse provider directly, not this URL). */
    parseUrl: string;
    /** `"local"` on self-hosted, `"clerk"`/`"oidc"` on hosted/enterprise. Used
     *  by setup/me routes to decide which flows to surface. */
    authAdapterKind: string;
    /** Billing adapter — feature gates, usage tracking, Stripe integration.
     *  Self-hosted uses NoOpBillingAdapter (all gates pass, no metering). */
    billing: BillingAdapter;
  };
};
