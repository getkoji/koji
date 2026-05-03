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

## UI components: use `@koji/ui`

The shared component library lives at `koji/packages/ui/` (package name `@koji/ui`). It's built on shadcn/ui with Koji branding. **Use these components instead of raw HTML elements.**

```typescript
import { Button, Dialog, Popover, Checkbox, Select, Textarea, Tabs, Badge } from "@koji/ui";
```

Available components include: Accordion, AlertDialog, Avatar, Badge, Button, ButtonGroup, Calendar, Card, Checkbox, Collapsible, Combobox, Command, ContextMenu, Dialog, Drawer, DropdownMenu, Field, Form, HoverCard, Input, Kbd, Label, Menubar, NativeSelect, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Sheet, Sidebar, Skeleton, Slider, Spinner, Switch, Table, Tabs, Textarea, Toggle, ToggleGroup, Tooltip.

The package exports from `./src/index.ts` and also supports deep imports via `@koji/ui/components/ui/<name>`.

**Note:** Many existing pages still use raw `<button>` / `<input>` elements (legacy). New code should use `@koji/ui`. A full migration pass is tracked as oss-155.
