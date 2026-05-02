@AGENTS.md

# Dashboard rules

## API calls: always use the shared client

**Never use raw `fetch()` for API calls.** Always use the shared API client from `@/lib/api`:

```typescript
import { api } from "@/lib/api";

// GET
const data = await api.get<ResponseType>("/api/endpoint");

// POST with JSON
const result = await api.post<ResponseType>("/api/endpoint", { body });

// POST with FormData
const result = await api.postForm<ResponseType>("/api/endpoint", formData);

// PATCH
const result = await api.patch<ResponseType>("/api/endpoint", { body });

// Streaming (SSE)
const response = await api.streamForm("/api/endpoint", formData, signal);
```

The shared client handles:
- `x-koji-tenant` header (required for all tenant-scoped endpoints)
- Auth tokens (Bearer for Clerk, cookie for local auth)
- `credentials: "include"` when using cookie auth
- Consistent error handling via `ApiError`

Raw `fetch()` will miss the tenant header and auth, causing silent 400/401 errors. This has caused bugs multiple times — do not repeat it.
