# @koji/api-spec

The OpenAPI 3.1 contract for the Koji API.

This package contains a single authoritative spec file (`openapi.yaml`) plus
the Redocly lint configuration. It is the **source of truth** for:

- Generated TypeScript types consumed via `@koji/types/api` (built by
  `platform-9`, not this task).
- Server-side request/response validation in `platform/apps/hosted`
  (`platform-16`).
- Public API reference documentation on `getkoji.dev/docs/reference/api`.
- SDK clients for the CLI, the SDK package, and any future language
  bindings.

`openapi.yaml` is authored by hand against `docs/specs/api-endpoints.md`
(endpoint inventory) and `docs/specs/database-schema.md` (resource shapes
— stripped of internal fields). If the two disagree, the spec docs win
and this file is updated in the same PR.

## Layout

```
packages/api-spec/
├── openapi.yaml    # the spec — single file, hand-authored
├── redocly.yaml    # Redocly lint config
├── package.json    # workspace package manifest
└── README.md
```

## Working with the spec

### Lint

```bash
pnpm --package=@redocly/cli@latest dlx redocly lint openapi.yaml
```

(Or, from this package directory, `pnpm lint` once `package.json` scripts
are wired into the monorepo's runner.)

The lint config inherits the Redocly `recommended` ruleset with two
exceptions documented inline in `redocly.yaml`:

- `no-server-example.com` is disabled because `http://localhost:9400/v1`
  is a real self-hosted default, not a placeholder.
- `operation-4xx-response` is disabled because `/health` and `/ready` are
  liveness probes that intentionally advertise only 2xx/5xx.

### Bundle

```bash
pnpm --package=@redocly/cli@latest dlx redocly bundle openapi.yaml \
  -o dist/openapi.bundled.yaml
```

Useful when feeding the spec into tools that don't resolve `$ref`
chains cleanly.

### Preview with Scalar (local)

A local-only Scalar renderer lives at `docs/index.html`. It loads
`../openapi.yaml` at runtime via Scalar's CDN bundle — no build step, no
deployment, no state. From the package root:

```bash
pnpm docs
# serves the package on http://localhost:9601
# then open http://localhost:9601/docs/
```

Under the hood this is `python3 -m http.server 9601` rooted at the
package directory, so the HTML's relative `../openapi.yaml` resolves to
the top-level spec file. Any editor can be used while the server runs —
just refresh the browser to pick up changes.

This preview is intentionally **local-only**. A public docs site for the
API reference is a follow-up task (`design-20`) that will land alongside
the marketing docs site build; until then, do not expose port 9601
beyond localhost.

If `python3` is not on `PATH`, any static server rooted at this package
directory works — e.g. `pnpm --package=serve dlx serve .` or a bespoke
`vite preview`.

### Preview via Redocly CLI

As an alternative to Scalar, Redocly ships its own previewer:

```bash
pnpm --package=@redocly/cli@latest dlx redocly preview-docs openapi.yaml
```

## Conventions

- **Paths** follow `api-endpoints.md` §3–§15 verbatim. Tenant scoping uses
  `/projects/{projectSlug}/…`, not `/t/{tenantSlug}/…` — the spec doc and
  the database schema both use the `projects` terminology.
- **Resource shapes** match `database-schema.md`, minus fields that are
  purely internal: `tenant_id`, `deleted_at`, `key_hash`, `secret_encrypted`,
  `auth_json`, `webhook_secret`.
- **Errors** are RFC 7807 problem details with a `trace_id` extension.
  Cross-tenant misses return `404`, never `403`, per `auth-permissioning.md`
  §5.2 — no existence leak.
- **Pagination** is cursor-based for unbounded collections; the envelope
  is defined once in `components.schemas.CursorPage`.
- **Idempotency** is surfaced via a reusable `Idempotency-Key` header
  parameter on every mutating operation.
- **SSE endpoints** (job stream, agent message stream) document the event
  envelope via `JobStreamEvent` and `AgentStreamEvent` component schemas.
  OpenAPI does not model SSE natively — the `text/event-stream` response
  advertises the schema for client-side type generation only.

## Regenerating dependent artifacts

Downstream consumers that must re-run when this file changes:

- `platform/packages/types` — regenerates `@koji/types/api` via
  `openapi-typescript`. Any change here should trigger a rebuild there.
- `platform/apps/hosted` — validation middleware is spec-driven and will
  pick up changes on next build.
- `website/src/docs/reference/api` — the Astro docs site builds against
  the bundled spec.

None of those consumers exist yet (`platform-9`, `platform-16`, `design-20`
respectively). This file is the contract they will eventually inherit.

## Change discipline

1. **Breaking changes bump the major version** and require maintaining the
   previous surface for 6 months minimum.
2. **Additive changes** (new endpoints, new optional fields) are allowed
   without a version bump.
3. **Every change here requires a matching update to `api-endpoints.md`**
   in the same PR — the spec doc is the narrative source of truth; this
   file is the machine-readable contract.
4. **Never edit the generated bundle** (`dist/openapi.bundled.yaml`) by
   hand. Edit `openapi.yaml` and re-bundle.
