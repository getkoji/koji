import type { Db } from "@koji/db";
import type { AuthAdapter, Principal } from "./auth/adapter";
import type { DirectoryAdapter } from "./auth/directory";
import type { Permission } from "./auth/roles";
import type { BillingAdapter } from "./billing/adapter";
import type { EmailSender } from "./email/provider";
import type { QueueProvider } from "./queue/provider";
import type { ParseProvider } from "./parse/provider";
import type { ParseConfig } from "./parse/factory";
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
    /** Resolved project ID — the intra-tenant isolation boundary. Set by the
     *  auth middleware from the x-koji-project header, the API key's bound
     *  project, or the tenant's default project. Undefined only for tenants
     *  with zero projects (mid-setup). */
    projectId: string | undefined;
    /** The projects the current session member may access, or `null` when the
     *  member is unrestricted (all projects). Set by the auth middleware. */
    accessibleProjectIds: Set<string> | null;
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
    /** External identity directory, or `null` when Koji owns identity itself
     *  (self-hosted). When set, membership existence and invitation delivery
     *  belong to the directory; roles stay Koji's. See `auth/directory.ts`. */
    directory: DirectoryAdapter | null;
    /** 64-hex master key for envelope encryption; null if not configured. */
    masterKey: string | null;
    /** Public URL of the dashboard — used in password-reset and invite emails. */
    appUrl: string;
    /** Base URL for the parse service (self-hosted sidecar; Workers path uses a
     *  parse provider directly, not this URL). */
    parseUrl: string;
    /** `"local"` on self-hosted, `"clerk"`/`"oidc"` on hosted/enterprise. Used
     *  by setup/me routes to decide which flows to surface. */
    authAdapterKind: string;
    /** Billing adapter — feature gates, usage tracking, Stripe integration.
     *  Self-hosted uses NoOpBillingAdapter (all gates pass, no metering). */
    billing: BillingAdapter;
    /** Parse provider for direct parsing (Workers) or sidecar proxy (Node). */
    parseProvider: ParseProvider;
    /**
     * The {@link ParseConfig} the default `parseProvider` was built from. When
     * present, routes can rebuild a per-tenant parse provider at call time (BYO
     * parse) — mirrors how `handleIngestionProcess` resolves the tenant's parse
     * provider so test/build mode matches production. Null when the caller only
     * supplied a pre-built provider (per-tenant resolution disabled → default
     * provider used unchanged). */
    parseConfig: ParseConfig | null;
    /** Tenant ID resolved from an API key (set by auth middleware). */
    apiKeyTenantId: string | undefined;
    /** The API key's DEFAULT project, or undefined for an all-access key
     *  (set by auth middleware). See `api_keys.project_id`. */
    apiKeyProjectId: string | undefined;
    /** The authenticating API key's id — used to resolve its multi-project
     *  grant set (set by auth middleware). */
    apiKeyId: string | undefined;
  };
};
