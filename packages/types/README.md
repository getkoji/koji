# @koji/types

Shared TypeScript types for the Koji platform. Four entry points:

```ts
import type { paths, components } from "@koji/types/api";     // OpenAPI-generated
import type { Document, Job, Schema } from "@koji/types/db";  // Drizzle-inferred row types
import { DocumentState, Role, JobStatus } from "@koji/types/enums"; // Domain enums
import type { Problem } from "@koji/types/errors";            // Error envelope
import { ErrorCode, isProblem } from "@koji/types/errors";
```

## Entry points

### `@koji/types/api`

Re-exports `paths`, `components`, and `operations` from `src/api.generated.ts`, which is produced by [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) from `@koji/api-spec/openapi.yaml`.

Regenerate after spec changes:

```bash
pnpm --filter @koji/types generate
```

### `@koji/types/db`

Drizzle `InferSelectModel` / `InferInsertModel` types for every table in `@koji/db`. Consumers import from here so they don't need a direct dependency on the db package (which pulls in `drizzle-orm`, `postgres`, etc.).

### `@koji/types/enums`

Hand-written `const` objects + union types for every string-enum in the domain: document states, job statuses, roles, stage names, model providers, etc. These are the single source of truth — both the API spec and the DB schema reference the same string values.

### `@koji/types/errors`

The RFC 7807 `Problem` interface, the `ErrorCode` enum of known machine-readable codes, and a `isProblem` type guard.

## Testing

```bash
pnpm --filter @koji/types test
```

Runs `tsc --noEmit` against `tsconfig.test.json`, which includes `src/smoke.test.ts` — a compile-time-only file that imports from all four entry points and asserts structural soundness. If it compiles, the types resolve.

## Consumers

- `platform/apps/dashboard` — imports API types for fetch wrappers, DB types for prop shapes, enums for UI state.
- `platform/apps/hosted` — imports API types for handler validation, DB types for query results, error types for response shaping.
- `platform/packages/sdk` (future) — will import API types for client generation.
