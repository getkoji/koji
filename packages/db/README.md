# @koji/db

Postgres schema (Drizzle) and tenant-scoped DB access for the Koji platform.

**Postgres is the only supported database.** Both deployment targets run Postgres 15+:

- **Hosted:** [Neon Postgres](https://neon.tech) reached from Cloudflare Workers via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/).
- **Self-hosted:** a Postgres container shipped alongside the koji services (Docker Compose or an equivalent helm chart). Operators can point at an existing external Postgres via `DATABASE_URL`.

See `docs/specs/database-schema.md` §2.2 for the decision rationale. SQLite and D1 are not supported and are not planned unless hobbyist / air-gapped installs become a real ask.

## Layout

```
packages/db/
├── drizzle/                    # migration SQL (generated + RLS)
│   ├── 0000_initial.sql        # Drizzle-generated CREATE TABLE + indexes
│   ├── 0001_rls.sql            # hand-written RLS policies
│   └── meta/
├── drizzle.config.ts           # drizzle-kit config, targets Postgres only
├── src/
│   ├── index.ts                # createDb, RLS_POLICIES, GLOBAL_TABLES
│   ├── rls.ts                  # withRLS wrapper (required for every query)
│   ├── rls.test.ts             # round-trip RLS test via Testcontainers
│   ├── migrate.ts              # migration runner (CLI + importable)
│   └── schema/
│       ├── _shared.ts          # primaryKey/createdAt/tenantId/bytea/inet helpers
│       ├── tenants.ts          # tenants, users, memberships, api_keys, audit_log
│       ├── schemas.ts          # schemas, schema_versions, schema_samples
│       ├── corpus.ts           # corpus_entries
│       ├── runs.ts             # schema_runs, schema_run_models, corpus_version_results
│       ├── pipelines.ts        # pipelines, sources, ingestions
│       ├── jobs.ts             # jobs, documents, traces, trace_stages
│       ├── review.ts           # review_items
│       ├── endpoints.ts        # model_endpoints, endpoint_usage_rollups
│       ├── agent.ts            # agent_sessions, agent_messages, agent_proposed_edits
│       ├── playground.ts       # playground_sessions, extractions, rate_limits
│       ├── webhooks.ts         # webhook_targets, webhook_deliveries
│       └── billing.ts          # enterprise_contracts, billable_events, invoices, stripe_events
└── package.json
```

## Running migrations

```bash
# locally, against a running Postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/koji \
  pnpm --filter @koji/db migrate
```

`migrate.ts` first runs every entry in `drizzle/meta/_journal.json` via Drizzle's migrator (just `0000_initial.sql` today), then executes `drizzle/0001_rls.sql` to apply the hand-written RLS policies. Drizzle Kit does not emit `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` statements, so RLS lives in a parallel SQL file that the runner concatenates on top.

### Generating a new migration

```bash
pnpm --filter @koji/db generate
```

This runs `drizzle-kit generate` against the live schema in `src/schema/` and emits a new `drizzle/NNNN_{name}.sql` plus a journal entry. After generating:

1. Diff the SQL for anything surprising (unnecessary column renames, bad defaults).
2. If the new migration touches a tenant-scoped table, add a matching `ALTER TABLE ... ENABLE RLS` + `CREATE POLICY` block to a new `drizzle/NNNN_rls.sql` file and update the runner to apply it.
3. Add the new table name to `RLS_POLICIES` in `src/index.ts` and to the coverage assertion in `src/rls.test.ts`. The test is the safety net — it fails the build if a tenant-scoped table is missing a policy.
4. Run `pnpm --filter @koji/db test` to confirm the round-trip still holds.

### Applying migrations in production

Hosted platform: migrations run from the release pipeline via a one-shot job against the Neon branch, gated on the staging smoke test passing. Self-hosted: migrations run on service start by default; operators can opt out with `KOJI_MIGRATE_ON_START=0`.

## The `withRLS` wrapper (contract)

**Every handler that touches a tenant-scoped table goes through `withRLS`.** Direct `db.select(...)` calls against a tenant-scoped table either return zero rows (if the connection has no prior setting) or the wrong tenant's rows (if a stale setting is still on the connection). The wrapper guarantees neither happens.

```ts
import { createDb, withRLS, schema } from "@koji/db";

const db = createDb(process.env.DATABASE_URL!);

// Inside a request handler, after resolving the session to a tenant:
const schemas = await withRLS(db, session.tenantId, async (tx) => {
  return tx.select().from(schema.schemas).limit(50);
});
```

Internally, `withRLS`:

1. Validates the `tenantId` against a strict UUID regex (any other input is rejected with an error — this is the injection guard for the `SET LOCAL` statement below).
2. Opens a transaction on `db`.
3. Issues `SET LOCAL app.current_tenant_id = '<uuid>'` inside the transaction. `SET LOCAL` scopes the setting to the transaction, so it's cleared on commit/rollback and never leaks to the next query on the same connection.
4. Runs `fn` with the transaction as its only argument.
5. Commits on success; rolls back on throw.

The RLS policies read `current_setting('app.current_tenant_id', true)::uuid`. The `true` argument is "missing_ok" — a connection that never called `withRLS` returns `NULL`, which never matches a real UUID, so queries return zero rows. This is the safe default: **forgetting to set the tenant is not a data-leak bug, it's an "empty result set" bug, which is trivially visible in dev.**

**The Postgres role matters.** RLS is bypassed by any role with the `BYPASSRLS` attribute, including every Postgres superuser. Runtime connections must use a non-superuser role — the hosted platform uses a dedicated `app_user` role created during deploy; self-hosted installs provision the equivalent at bootstrap. The test suite (`src/rls.test.ts`) demonstrates the pattern: a superuser connection applies migrations and seeds data, and a separate non-superuser connection exercises the policies.

See `docs/specs/auth-permissioning.md` §5.3 for the full contract.

## Testing

```bash
pnpm --filter @koji/db test
```

Requires Docker — the test harness uses [`@testcontainers/postgresql`](https://node.testcontainers.org/modules/postgresql/) to spin up a real Postgres 16, apply the full migration stream (CREATE TABLE + RLS), and exercise the `withRLS` wrapper end-to-end.

The test asserts five things:

1. A connection without `SET LOCAL app.current_tenant_id` sees **zero** tenant-scoped rows — the safe default.
2. `withRLS(tenantA, ...)` sees only tenant A's rows, even for queries that omit an explicit `WHERE tenant_id = ...` clause.
3. Two tenants writing to the same table with the same slug do not collide and do not see each other's rows.
4. `withRLS` rejects non-UUID tenant ids with an error (the `SET LOCAL` injection guard).
5. Every tenant-scoped table in `RLS_POLICIES` has a matching entry in `pg_policies` after migrations run — the coverage check that prevents new tables from silently landing without a policy.

This test is intentionally the only test file in the package. The RLS path is the single most dangerous surface in the DB layer, and a real Postgres check is the only way to catch regressions in it. Per-table CRUD happy-path tests live in the consumer packages that actually use the tables.

## Consumers

- `platform/apps/hosted` — the Cloudflare Workers API. Imports `createDb`, `withRLS`, and the schema exports. Every handler wraps its DB access in `withRLS(db, session.tenantId, ...)`.
- `platform/packages/types` (platform-9) — re-exports TypeScript types inferred from `src/schema/*.ts` so consumers don't need to depend on the whole DB package for compile-time types.
- Self-hosted service entry points — import `runMigrations` and call it at startup (behind the `KOJI_MIGRATE_ON_START` flag).
